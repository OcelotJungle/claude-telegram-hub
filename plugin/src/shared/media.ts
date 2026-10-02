import { extname } from 'path'

// Bot API upload limits.
export const MAX_UPLOAD = 50 * 1024 * 1024
export const MAX_PHOTO = 10 * 1024 * 1024
export const MAX_CAPTION = 1024
export const MAX_ALBUM = 10

// Also the Bot API method suffix (sendPhoto…) and the upload field name.
export type FileKind = 'photo' | 'video' | 'audio' | 'animation' | 'document'

// A file queued for the topic: path is the hub's own copy, name the original.
export type OutFile = { path: string; name: string; size: number; kind: FileKind }

const BY_EXT: Record<string, FileKind> = {
  '.jpg': 'photo',
  '.jpeg': 'photo',
  '.png': 'photo',
  '.webp': 'photo',
  '.mp4': 'video',
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.gif': 'animation',
}

// What Telegram shows natively; anything else is a document.
export function kindOf(name: string, size: number): FileKind {
  const kind = BY_EXT[extname(name).toLowerCase()] ?? 'document'
  return kind === 'photo' && size > MAX_PHOTO ? 'document' : kind
}

// Kinds that may share a media group. Animations cannot be in one.
function family(kind: FileKind): string | undefined {
  if (kind === 'photo' || kind === 'video') return 'visual'
  return kind === 'animation' ? undefined : kind
}

// Splits files into Telegram sends, keeping their order: consecutive files of
// one family share an album of up to 10.
export function albums(files: OutFile[]): OutFile[][] {
  const out: OutFile[][] = []
  for (const file of files) {
    const last = out.at(-1)
    const fam = family(file.kind)
    if (last && fam && family(last[0]!.kind) === fam && last.length < MAX_ALBUM) last.push(file)
    else out.push([file])
  }
  return out
}
