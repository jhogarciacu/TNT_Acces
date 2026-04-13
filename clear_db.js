const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
    await prisma.miembro.deleteMany({});
    console.log("All members deleted to free up huella_id slots.");
    await prisma.$disconnect();
}
run();
