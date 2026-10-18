// Usage: pnpm --filter api make-admin <email> [ADMIN|STAFF|CUSTOMER]   (default ADMIN)
import { PrismaClient, Role } from '@prisma/client';

async function main() {
  const email = process.argv[2]?.toLowerCase();
  const role = (process.argv[3]?.toUpperCase() ?? 'ADMIN') as Role;
  if (!email || !Object.values(Role).includes(role)) {
    console.error('Usage: pnpm --filter api make-admin <email> [ADMIN|STAFF|CUSTOMER]');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.update({ where: { email }, data: { role } });
    console.log(`${user.email} is now ${role}. They must log in again to get a fresh token.`);
  } catch {
    console.error(`No user with email ${email}. Register first.`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}
main();
