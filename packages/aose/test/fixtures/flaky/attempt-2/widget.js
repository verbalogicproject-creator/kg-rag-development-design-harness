// Attempt 2: corrected after reading the failing gate output.
export function total(items) {
  let sum = 0;
  for (let i = 0; i < items.length; i += 1) sum += items[i];
  return sum;
}
