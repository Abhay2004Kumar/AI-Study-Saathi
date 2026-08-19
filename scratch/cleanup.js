const p = require('../src/config/db');
async function cleanup() {
  const user = await p.user.findFirst({ where: { email: 'tutor_interactive@example.com' } });
  if (!user) { console.log('no user found'); return; }
  await p.documentChunk.deleteMany({});
  await p.document.deleteMany({ where: { userId: user.id } });
  await p.tutorSession.deleteMany({ where: { userId: user.id } });
  await p.user.delete({ where: { id: user.id } });
  console.log('cleaned up user:', user.email);
}
cleanup().catch(e => console.log('err:', e.message)).finally(() => p.$disconnect());
