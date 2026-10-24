/** "1 caption", "3 captions": counts people read in the editor. */
export function plural(count: number, word: string, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}
