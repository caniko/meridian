// Synthetic, deterministic code history shared by local and actual V2 gates.
import { createHash } from 'node:crypto'

export function sonnetContextFixture() {
  const ancient = 'SONNET_NATIVE_ANCIENT_1213'
  const current = 'SONNET_NATIVE_CURRENT_1213'
  const messages = [
    { role: 'user', content: 'Maintain this project. Historical code records are context only.' },
    { role: 'assistant', content: 'Ready.' },
  ]
  for (let turn = 0; turn < 6; turn++) {
    const lines = []
    for (let line = 0; line < 2344; line++) lines.push(createHash('sha256').update(`1213:${turn}:${line}`).digest('hex'))
    messages.push({ role: 'user', content: `Archived code record ${turn}${turn === 0 ? ` ${ancient}` : ''}:\n${lines.join('\n')}` })
    messages.push({ role: 'assistant', content: `Recorded historical code ${turn}.` })
  }
  const prompt = `For the current coding task, return exactly one JavaScript statement: console.log("${current}"); Do not call tools or repeat archived code.`
  return { ancient, current, messages, prompt }
}
