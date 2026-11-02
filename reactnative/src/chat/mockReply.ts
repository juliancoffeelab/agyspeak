// Deliberately local and synchronous: no model, credentials, or network calls.
export function mockReply(message: string): string {
  if (/^(hi|hey|hello)\b/i.test(message)) {
    return 'Hey. What’s on your mind?';
  }
  if (message.includes('?')) {
    return 'Excellent question. My mock brain has considered it and would like you to elaborate.';
  }
  return 'Got it. My entire brain is a few lines of code right now, but I’m listening. Keep going.';
}
