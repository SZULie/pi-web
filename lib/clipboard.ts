export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
  } catch {
    return Promise.reject();
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await copyText(text);
    return true;
  } catch {
    return false;
  }
}

export function shellQuote(str: string): string {
  if (/^[a-zA-Z0-9_./~-]+$/.test(str)) {
    return str;
  }
  return `'${str.replaceAll("'", "'\\''")}'`;
}

export function formatSessionResumeCommand(session: { id: string; cwd?: string }): string {
  const cwd = session.cwd?.trim();
  const id = session.id.trim();
  if (cwd === undefined || cwd === "") return `pi --session ${shellQuote(id)}`;
  return `cd ${shellQuote(cwd)} && pi --session ${shellQuote(id)}`;
}
