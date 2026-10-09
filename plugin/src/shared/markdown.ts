import type { Token, Tokens } from 'marked'

import { decodeHTML } from 'entities'
import { Lexer } from 'marked'

// A Bot API MessageEntity. Offsets and lengths count UTF-16 code units, as
// JavaScript string indices do.
export type Entity = {
  type: 'bold' | 'italic' | 'strikethrough' | 'code' | 'pre' | 'text_link' | 'blockquote'
  offset: number
  length: number
  url?: string
  language?: string
}

// Plain text plus the entities that format it.
export type Formatted = { text: string; entities: Entity[] }

const INDENT = '   '

// Writes plain text and records entities over it. Text inside a list item
// gets the item's indent at every line start.
class Builder {
  text = ''
  private ents: { e: Entity; order: number }[] = []
  private indent = ''
  private lineStart = true
  quoteDepth = 0
  listDepth = 0

  put(s: string): void {
    for (const part of s.split(/(\n)/)) {
      if (part === '\n') {
        this.text += '\n'
        this.lineStart = true
      } else if (part) {
        if (this.lineStart) this.text += this.indent
        this.lineStart = false
        this.text += part
      }
    }
  }

  wrap(e: Omit<Entity, 'offset' | 'length'>, fn: () => void): void {
    // The indent owed at a line start goes before the entity, not into it.
    const start = this.text.length + (this.lineStart ? this.indent.length : 0)
    fn()
    if (this.text.length > start) this.ents.push({ e: { ...e, offset: start, length: this.text.length - start }, order: this.ents.length })
  }

  indented(fn: () => void): void {
    const saved = this.indent
    this.indent += INDENT
    fn()
    this.indent = saved
  }

  // Trims the text and sorts the entities: by offset, outer before inner.
  result(): Formatted {
    const lead = this.text.length - this.text.trimStart().length
    const text = this.text.trim()
    const entities = this.ents
      .map(({ e, order }) => {
        const start = Math.max(e.offset - lead, 0)
        const end = Math.min(e.offset + e.length - lead, text.length)
        return { e: { ...e, offset: start, length: end - start }, order }
      })
      .filter(x => x.e.length > 0)
      .sort((a, b) => a.e.offset - b.e.offset || b.e.length - a.e.length || b.order - a.order)
      .map(x => x.e)
    return { text, entities }
  }
}

// Agent text is Markdown (CommonMark + GFM). Telegram gets plain text and
// entities: nothing to escape, and a long text splits like plain text.
export function toTelegram(md: string): Formatted {
  const b = new Builder()
  blocks(b, new Lexer({ gfm: true }).lex(md), '\n\n')
  return b.result()
}

// Links Telegram can open from a text_link.
function openable(url: string): boolean {
  return /^(https?|tg):\/\//i.test(url)
}

function blocks(b: Builder, tokens: Token[], gap: string): void {
  let first = true
  for (const t of tokens) {
    if (t.type === 'space' || t.type === 'def' || t.type === 'checkbox') continue
    if (!first) b.put(gap)
    first = false
    block(b, t)
  }
}

function block(b: Builder, t: Token): void {
  switch (t.type) {
    case 'paragraph':
      return inline(b, t.tokens ?? [])
    case 'text':
      return t.tokens ? inline(b, t.tokens) : b.put(decodeHTML(t.text))
    case 'heading':
      return b.wrap({ type: 'bold' }, () => inline(b, t.tokens ?? []))
    case 'code': {
      const language = (t as Tokens.Code).lang?.split(/\s/)[0]
      return b.wrap({ type: 'pre', ...(language ? { language } : {}) }, () => b.put(t.text))
    }
    case 'blockquote':
      // Telegram does not nest blockquotes.
      if (b.quoteDepth) return blocks(b, t.tokens ?? [], '\n\n')
      b.quoteDepth++
      b.wrap({ type: 'blockquote' }, () => blocks(b, t.tokens ?? [], '\n\n'))
      b.quoteDepth--
      return
    case 'list':
      return list(b, t as Tokens.List)
    case 'table':
      return table(b, t as Tokens.Table)
    case 'hr':
      return b.put('———')
    case 'html':
      return b.put(t.text.replace(/\n+$/, ''))
    default:
      return b.put('text' in t && typeof t.text === 'string' ? t.text : t.raw)
  }
}

function list(b: Builder, t: Tokens.List): void {
  const start = typeof t.start === 'number' ? t.start : 1
  t.items.forEach((item, i) => {
    if (i) b.put(t.loose ? '\n\n' : '\n')
    const marker = item.task ? (item.checked ? '☑' : '☐') : t.ordered ? `${start + i}.` : b.listDepth % 2 ? '◦' : '•'
    b.put(`${marker} `)
    b.indented(() => {
      b.listDepth++
      blocks(b, item.tokens, item.loose ? '\n\n' : '\n')
      b.listDepth--
    })
  })
}

// Telegram has no tables: a monospace block with aligned columns.
function table(b: Builder, t: Tokens.Table): void {
  const rows = [t.header, ...t.rows].map(r => r.map(c => plain(c.tokens)))
  const widths = t.header.map((_, i) => Math.max(...rows.map(r => r[i]?.length ?? 0)))
  const pad = (s: string, i: number) => {
    const room = widths[i]! - s.length
    if (t.align[i] === 'right') return ' '.repeat(room) + s
    if (t.align[i] === 'center') return ' '.repeat(Math.floor(room / 2)) + s + ' '.repeat(Math.ceil(room / 2))
    return s + ' '.repeat(room)
  }
  const line = (r: string[]) => r.map((c, i) => pad(c, i)).join(' | ').trimEnd()
  const lines = [line(rows[0]!), widths.map(w => '-'.repeat(w)).join('-+-'), ...rows.slice(1).map(line)]
  b.wrap({ type: 'pre' }, () => b.put(lines.join('\n')))
}

function plain(tokens: Token[]): string {
  const b = new Builder()
  inline(b, tokens)
  return b.text
}

function inline(b: Builder, tokens: Token[]): void {
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        if (t.tokens) inline(b, t.tokens)
        else b.put(decodeHTML(t.text))
        break
      case 'escape':
        b.put(t.text)
        break
      case 'strong':
        b.wrap({ type: 'bold' }, () => inline(b, t.tokens ?? []))
        break
      case 'em':
        b.wrap({ type: 'italic' }, () => inline(b, t.tokens ?? []))
        break
      case 'del':
        b.wrap({ type: 'strikethrough' }, () => inline(b, t.tokens ?? []))
        break
      case 'codespan':
        b.wrap({ type: 'code' }, () => b.put(t.text))
        break
      case 'br':
        b.put('\n')
        break
      case 'link':
        link(b, t.href, () => inline(b, t.tokens ?? []), plain(t.tokens ?? []))
        break
      case 'image': {
        const label = t.text || t.href
        link(b, t.href, () => b.put(label), label)
        break
      }
      case 'checkbox':
        break
      case 'html':
        b.put(t.text)
        break
      default:
        b.put(t.raw)
    }
  }
}

// A bare URL or a link whose text is its URL stays plain: Telegram links it
// itself. A target Telegram cannot open stays visible after the text.
function link(b: Builder, href: string, content: () => void, label: string): void {
  if (label === href || `mailto:${label}` === href) return content()
  if (openable(href)) return b.wrap({ type: 'text_link', url: href }, content)
  content()
  b.put(` (${href})`)
}
