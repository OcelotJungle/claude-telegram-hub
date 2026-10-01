// Telegram caps a message at 4096 chars. Split long text, preferring paragraph,
// then line, then word boundaries past half the limit; hard cut otherwise.
export const MAX_MESSAGE = 4096

export function chunk(text: string, limit = MAX_MESSAGE): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > limit / 2 ? space : limit
    push(out, rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  push(out, rest)
  return out
}

function push(out: string[], piece: string): void {
  if (piece.trim()) out.push(piece.replace(/\s+$/, ''))
}
