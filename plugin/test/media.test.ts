import { describe, expect, test } from 'bun:test'
import { albums, kindOf, MAX_PHOTO, type OutFile } from '../src/shared/media.ts'

const MB = 1024 * 1024
const f = (name: string, kind = kindOf(name, 1)): OutFile => ({ path: `/q/${name}`, name, size: 1, kind })
const names = (groups: OutFile[][]) => groups.map(g => g.map(x => x.name))

describe('kindOf', () => {
  test('by extension, case-insensitive', () => {
    expect(['a.jpg', 'a.JPEG', 'a.png', 'a.webp'].map(n => kindOf(n, MB))).toEqual(['photo', 'photo', 'photo', 'photo'])
    expect(kindOf('clip.mp4', MB)).toBe('video')
    expect(kindOf('song.mp3', MB)).toBe('audio')
    expect(kindOf('song.m4a', MB)).toBe('audio')
    expect(kindOf('anim.gif', MB)).toBe('animation')
    for (const n of ['log.txt', 'a.pdf', 'clip.mov', 'voice.ogg', 'noext', 'image.svg']) expect(kindOf(n, MB)).toBe('document')
  })

  test('a photo over 10 MB goes as a document', () => {
    expect(kindOf('big.png', MAX_PHOTO)).toBe('photo')
    expect(kindOf('big.png', MAX_PHOTO + 1)).toBe('document')
  })
})

describe('albums', () => {
  test('one file is one send', () => {
    expect(names(albums([f('a.png')]))).toEqual([['a.png']])
  })

  test('consecutive photos and videos share an album, documents and audio get their own', () => {
    const files = [f('1.png'), f('2.mp4'), f('3.jpg'), f('a.pdf'), f('b.txt'), f('s1.mp3'), f('s2.m4a')]
    expect(names(albums(files))).toEqual([['1.png', '2.mp4', '3.jpg'], ['a.pdf', 'b.txt'], ['s1.mp3', 's2.m4a']])
  })

  test('order is kept: interleaved kinds are not regrouped', () => {
    expect(names(albums([f('1.png'), f('a.pdf'), f('2.png')]))).toEqual([['1.png'], ['a.pdf'], ['2.png']])
  })

  test('an album holds at most 10', () => {
    const files = Array.from({ length: 23 }, (_, i) => f(`${i}.png`))
    expect(albums(files).map(g => g.length)).toEqual([10, 10, 3])
  })

  test('an animation always goes alone', () => {
    expect(names(albums([f('1.png'), f('a.gif'), f('b.gif'), f('2.png')]))).toEqual([['1.png'], ['a.gif'], ['b.gif'], ['2.png']])
  })
})
