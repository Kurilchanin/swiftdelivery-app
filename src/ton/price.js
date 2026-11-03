// "0.1 GRAM" — how a fee or any GRAM amount is shown, on the pages and in the
// transaction summaries. Only GRAM, no dollar value next to it.
export function gramLabel(amount) {
  return `${amount} GRAM`
}
