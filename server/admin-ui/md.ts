// Markdown → HTML（marked）。模型输出里可能夹着网页内容，所以：原始 HTML 一律转义成文本，
// 链接只放行 http(s) / mailto，图片只放行 http(s) / data:image，链接都在新窗口打开。
import { Marked } from "marked";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const safeHref = (h: string) => (/^(https?:|mailto:)/i.test(h.trim()) ? h.trim() : "");
const safeSrc = (h: string) => (/^(https?:|data:image\/(png|jpe?g|gif|webp);base64,)/i.test(h.trim()) ? h.trim() : "");

const md = new Marked({ gfm: true, breaks: true });
md.use({
  renderer: {
    html(token: any) { return esc(token.text ?? token.raw ?? ""); },
    link(this: any, token: any) {
      const text = this.parser.parseInline(token.tokens);
      const href = safeHref(token.href ?? "");
      return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    },
    image(token: any) {
      const src = safeSrc(token.href ?? "");
      return src ? `<img src="${esc(src)}" alt="${esc(token.text ?? "")}" loading="lazy">` : esc(token.text ?? "");
    },
  },
});

export function renderMarkdown(src: string): string {
  try { return md.parse(src, { async: false }) as string; } catch { return `<pre>${esc(src)}</pre>`; }
}
