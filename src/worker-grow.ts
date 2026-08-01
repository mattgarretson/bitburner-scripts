export async function main(ns: NS): Promise<void> {
  const target = String(ns.args[0]);
  const delay = adjustedDelay(ns.args[1], ns.args[2]);
  await ns.grow(target, { additionalMsec: delay });
}

function adjustedDelay(
  requestedDelay: string | number | boolean | undefined,
  plannedAt: string | number | boolean | undefined,
): number {
  const launchSkew = Date.now() - Number(plannedAt ?? Date.now());
  return Math.max(0, Number(requestedDelay ?? 0) - launchSkew);
}
