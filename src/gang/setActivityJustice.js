/** @param {NS} ns */
export async function main(ns) {
  // ns.tprint(ns.gang.getTaskNames())
  let gangMembers = ns.gang.getMemberNames()
  for (let member of gangMembers) {
    ns.gang.setMemberTask(member, "Vigilante Justice")
  }
  
}