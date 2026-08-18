export function mergeExactLine(content: string, line: string): string {
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.length === 0 ? [] : normalized.split('\n')
  if (lines.at(-1) === '' && lines.length > 0) {
    lines.pop()
  }
  if (lines.includes(line)) {
    return content.length === 0 ? '' : content.endsWith('\n') ? content : `${content}\n`
  }
  if (content.length === 0) {
    return `${line}\n`
  }
  if (content.endsWith('\n')) {
    return `${content}${line}\n`
  }
  return `${content}\n${line}\n`
}
