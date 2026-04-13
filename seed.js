const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 30); // 30 days of membership

  // Upsert user with huella_id = 3
  const member = await prisma.miembro.upsert({
    where: { huella_id: 3 },
    update: {},
    create: {
      nombre: 'Invitado Especial',
      huella_id: 3,
      telefono: '555-0000',
      membership_end_date: tomorrow,
    },
  });

  console.log('Seeded member:', member);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
