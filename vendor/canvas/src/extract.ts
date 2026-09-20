/**
 * Text extraction for Canvas course files.
 *
 * PDF goes through unpdf (a bundled pdf.js build). Office formats are handled
 * here directly: .docx/.pptx/.xlsx are ZIP containers of XML, so a small ZIP
 * reader over Node's built-in zlib covers all three without a dependency.
 */
import { inflateRawSync } from "node:zlib";
import { htmlToText } from "./html.js";

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

type ZipEntry = { name: string; localOffset: number; compressedSize: number; method: number };

/** Read a ZIP's central directory. Entries are listed, not decompressed. */
function readZipDirectory(buf: Buffer): ZipEntry[] {
  // The end-of-central-directory record sits at the tail, after an optional
  // comment of up to 64KB, so scan backwards for its signature.
  let eocd = -1;
  const minRecord = 22;
  const scanFloor = Math.max(0, buf.length - minRecord - 0xffff);
  for (let i = buf.length - minRecord; i >= scanFloor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("file is not a valid ZIP archive (no end-of-central-directory record)");

  const count = buf.readUInt16LE(eocd + 10);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (dirOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported");

  const entries: ZipEntry[] = [];
  let p = dirOffset;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_HEADER_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    entries.push({
      name: buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
      localOffset,
      compressedSize,
      method,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decompress one entry. Sizes come from the central directory, which is
 *  authoritative — local headers may be zeroed when a data descriptor is used. */
function readZipEntry(buf: Buffer, entry: ZipEntry): string {
  if (buf.readUInt32LE(entry.localOffset) !== LOCAL_HEADER_SIG) {
    throw new Error(`corrupt ZIP: bad local header for ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(entry.localOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return data.toString("utf8");
  if (entry.method === 8) return inflateRawSync(data).toString("utf8");
  throw new Error(`unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

/** Strip XML markup to readable text, turning the given tags into line breaks. */
function xmlToText(xml: string, blockTags: string[]): string {
  let s = xml;
  for (const tag of blockTags) s = s.split(`</${tag}>`).join("\n");
  s = s.replace(/<w:tab\/>/g, "\t").replace(/<w:br\/>/g, "\n");
  s = s.replace(/<[^>]+>/g, "");

  s = s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&"); // last, so "&amp;lt;" doesn't become "<"

  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractDocx(buf: Buffer): string {
  const entries = readZipDirectory(buf);
  const doc = entries.find((e) => e.name === "word/document.xml");
  if (!doc) throw new Error("not a Word document (word/document.xml missing)");
  return xmlToText(readZipEntry(buf, doc), ["w:p"]);
}

function extractPptx(buf: Buffer): string {
  const entries = readZipDirectory(buf);
  const slides = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => {
      const n = (s: string) => Number(s.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      return n(a.name) - n(b.name);
    });
  if (!slides.length) throw new Error("not a PowerPoint file (no slides found)");

  const parts: string[] = [];
  slides.forEach((entry, i) => {
    const text = xmlToText(readZipEntry(buf, entry), ["a:p"]);
    if (text) parts.push(`--- Slide ${i + 1} ---\n${text}`);
  });
  return parts.join("\n\n");
}

function extractXlsx(buf: Buffer): string {
  const entries = readZipDirectory(buf);
  const shared = entries.find((e) => e.name === "xl/sharedStrings.xml");
  if (!shared) throw new Error("no shared strings found in workbook");
  // Cell values live in sharedStrings; this is a text dump, not a reconstructed grid.
  return xmlToText(readZipEntry(buf, shared), ["si"]);
}

export type ExtractResult = { text: string; kind: string; truncated: boolean };

/**
 * Extract readable text from a downloaded course file.
 * `contentType` and `filename` are both consulted — Canvas is inconsistent
 * about which one carries the real type.
 */
export async function extractFileText(
  buf: Buffer,
  filename: string,
  contentType: string | undefined,
  maxChars: number
): Promise<ExtractResult> {
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  const ct = (contentType ?? "").toLowerCase();
  const is = (e: string, mime: string) => ext === e || ct.includes(mime);

  let text: string;
  let kind: string;

  if (is("pdf", "application/pdf")) {
    kind = "PDF";
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const res = await extractText(pdf, { mergePages: true });
    text = String(res.text);
    kind = `PDF (${res.totalPages} pages)`;
  } else if (is("docx", "wordprocessingml")) {
    kind = "Word document";
    text = extractDocx(buf);
  } else if (is("pptx", "presentationml")) {
    kind = "PowerPoint";
    text = extractPptx(buf);
  } else if (is("xlsx", "spreadsheetml")) {
    kind = "Excel workbook (text dump — cell layout not preserved)";
    text = extractXlsx(buf);
  } else if (is("html", "text/html") || ext === "htm") {
    kind = "HTML";
    text = htmlToText(buf.toString("utf8"), maxChars);
  } else if (["txt", "md", "csv", "json", "py", "java", "js", "ts", "c", "cpp", "r", "sql"].includes(ext) || ct.startsWith("text/")) {
    kind = "plain text";
    text = buf.toString("utf8");
  } else {
    throw new Error(
      `Cannot extract text from "${filename}" (type: ${contentType ?? "unknown"}). ` +
        "Supported: PDF, DOCX, PPTX, XLSX, HTML, and plain-text formats. " +
        "Use canvas_get_file_link to download it directly instead."
    );
  }

  text = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error(`No extractable text in "${filename}" — it may be a scanned image or media file.`);

  const truncated = text.length > maxChars;
  return { text: truncated ? text.slice(0, maxChars) + "\n… [truncated]" : text, kind, truncated };
}
