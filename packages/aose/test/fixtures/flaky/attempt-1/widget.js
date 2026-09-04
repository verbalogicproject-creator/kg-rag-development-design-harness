// Attempt 1: an off-by-one a careless worker would ship.
export function total(items) {
  let sum = 0;
  for (let i = 0; i < items.length - 1; i += 1) sum += items[i];
  return sum;
}
