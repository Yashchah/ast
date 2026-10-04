import { Marked } from 'marked';

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Model output is untrusted: never pass raw HTML through to the webview.
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

export function md(text: string): string {
  return marked.parse(text ?? '', { async: false }) as string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function codeBlock(code: string): string {
  if (!code.trim()) return '';
  return code.trim().startsWith('```') ? code : '```\n' + code + '\n```';
}
