import { BrowserWindow, WebContentsView, type Session } from 'electron';
import { fileURLToPath } from 'node:url';

/** Trusted local controls stay outside the school's DOM and scripting world. */
export const LOGIN_TOOLBAR_HEIGHT = 120;
export function attachSchoolPage(window: BrowserWindow, session: Session, backgroundLogin = false) {
  const view = new WebContentsView({ webPreferences: {
    disableDialogs: backgroundLogin, backgroundThrottling: !backgroundLogin,
    session, preload: fileURLToPath(new URL('./login-preload.cjs', import.meta.url)),
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
  } });
  const layout = () => {
    if (window.isDestroyed()) return;
    const [width = 0, height = 0] = window.getContentSize();
    view.setBounds({ x: 0, y: LOGIN_TOOLBAR_HEIGHT, width, height: Math.max(0, height - LOGIN_TOOLBAR_HEIGHT) });
  };
  window.contentView.addChildView(view); window.on('resize', layout); layout();
  let closed = false;
  return { contents: view.webContents, close() {
    if (closed) return;
    closed = true; window.removeListener('resize', layout);
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  } };
}
