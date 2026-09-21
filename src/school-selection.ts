import { searchSchools, type SchoolMatch, type SchoolSearchOptions } from './schools.js';
import { question } from './terminal.js';
import { LmsError } from './errors.js';

export async function selectSchool(
  initialQuery: string | undefined,
  options: SchoolSearchOptions = {},
  ask = question,
  search = searchSchools,
  print = (message: string) => { process.stderr.write(`${message}\n`); },
): Promise<SchoolMatch | undefined> {
  print(options.offline || options.platform === 'blackboard' ? '仅搜索本地学校预设。' : '联网搜索会将学校名称或域名发送给 Canvas 官方目录，不发送账号或凭据。');
  let query = initialQuery;
  for (;;) {
    query ??= await ask('学校名称或域名（留空手动填写网址，q 取消）');
    if (!query || query.toLowerCase() === 'custom') return;
    if (query.toLowerCase() === 'q') throw new LmsError('CANCELLED', '已取消；没有保存学校配置。');
    let result;
    try { result = await search(query, options); }
    catch (error) {
      if (!(error instanceof LmsError) || error.code !== 'BAD_INPUT') throw error;
      print(error.message); query = undefined; continue;
    }
    for (const source of result.sources) if (source.status !== 'ok') print(source.message);
    if (!result.matches.length) print('当前来源没有返回匹配项，可更换关键词或手动填写学校网址。');
    else {
      result.matches.forEach((match, index) => print(`${index + 1}. ${match.name} [${match.source === 'preset' ? '本地预设' : 'Canvas 官方目录'}]\n   ${Object.entries(match.platforms).map(([platform, origin]) => `${platform}: ${origin}`).join(' · ')}`));
      print(result.note);
    }
    for (;;) {
      const selected = await ask('输入编号选择学校，r 重新搜索，m 手动填写，q 取消');
      if (selected.toLowerCase() === 'q') throw new LmsError('CANCELLED', '已取消；没有保存学校配置。');
      if (selected.toLowerCase() === 'm') return;
      if (selected.toLowerCase() === 'r') { query = undefined; break; }
      if (/^[1-9]\d*$/.test(selected)) {
        const match = result.matches[Number(selected) - 1];
        if (match) return match;
      }
      print('请输入列表中的编号，或 r / m / q。');
    }
  }
}
