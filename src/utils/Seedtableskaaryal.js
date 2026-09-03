require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const Branch = require('../models/Branch');
const Table = require('../models/Table');
require('dotenv').config();

// ── Config ────────────────────────────────────────────────────────
const BRANCH_NAME      = 'Al Madina Fast Food-Kaaryal';
const FLOORS           = ['ground_floor', 'first_floor', 'second_floor', 'outdoor'];
const TABLES_PER_FLOOR = 30;
const CAPACITY         = 4;

const seedTablesKaaryal = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Connected\n');

    // ============================================================
    // 🛡️ GUARD: Sirf Kaaryal branch dhoondo (naam se)
    // ============================================================
    const branch = await Branch.findOne({ name: BRANCH_NAME });

    if (!branch) {
      console.error(`❌  Branch "${BRANCH_NAME}" nahi mili database mein. Pehle addBranch2.js chalao.`);
      process.exit(1);
    }

    console.log(`🏢  Branch mili: ${branch.name} (${branch.city})`);
    console.log(`    ID: ${branch._id}\n`);

    // STEP 1: Is branch ki purani occupied tables reset karo
    const resetResult = await Table.updateMany(
      { branchId: branch._id, isOccupied: true },
      { $set: { isOccupied: false, currentOrderId: null } }
    );
    console.log(`🔄  ${resetResult.modifiedCount} tables ka occupancy reset kiya`);

    // STEP 2: 30 tables per floor ensure karo (upsert — duplicate safe)
    for (const floor of FLOORS) {
      let created = 0;
      let skipped = 0;

      for (let tableNumber = 1; tableNumber <= TABLES_PER_FLOOR; tableNumber++) {
        try {
          await Table.findOneAndUpdate(
            { branchId: branch._id, tableNumber, floor },
            {
              $setOnInsert: {
                tableNumber,
                capacity:   CAPACITY,
                floor,
                branchId:   branch._id,
                isOccupied: false,
                isActive:   true,
              },
            },
            { upsert: true, new: true }
          );
          created++;
        } catch (e) {
          if (e.code === 11000) { skipped++; }
          else console.error(`  ❌  floor=${floor} table=${tableNumber}:`, e.message);
        }
      }
      console.log(`  ✓  ${floor.replace(/_/g, ' ')} — ${created} OK, ${skipped} skipped`);
    }

    const total = await Table.countDocuments({ branchId: branch._id });
    console.log(`\n📊  Total tables in DB for ${branch.name}: ${total}`);

    console.log('\n' + '='.repeat(60));
    console.log('🎉 KAARYAL TABLES SEED COMPLETE!');
    console.log('='.repeat(60));

    process.exit(0);
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    process.exit(1);
  }
};

seedTablesKaaryal();