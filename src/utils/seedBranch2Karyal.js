require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Branch = require('../models/Branch');
require('dotenv').config();

const BRANCH_NAME = 'Al Madina Fast Food-Kaaryal';

const addBranch2 = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Connected');

    // ============================================================
    // 🛡️ GUARD: Agar yeh branch pehle se exist karti hai to skip
    // ============================================================
    let branch = await Branch.findOne({ name: BRANCH_NAME });

    if (branch) {
      console.log('\n' + '='.repeat(60));
      console.log('⚠️  BRANCH ALREADY EXISTS — SKIPPING BRANCH CREATION');
      console.log('='.repeat(60));
      console.log('   Branch:', branch.name, '| ID:', branch._id.toString());
    } else {
      console.log('\n🏢 Creating branch 2...');
      branch = await Branch.create({
        name: BRANCH_NAME,
        address: 'Main Bazar, Kaaryal',
        city: 'Kaaryal',
        phone: '0410000002',
        isActive: true,
        openingTime: '09:00',
        closingTime: '23:00',
      });
      console.log('✅ Branch created:', branch.name);
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash('password123', salt);

    // ============================================================
    // Users to add for this branch (skip if email already exists)
    // ============================================================
    const usersToCreate = [
      {
        name: 'Cashier Kaaryal',
        email: 'cashier.kaaryal@almadina.com',
        password: hashedPassword,
        role: 'cashier',
        phone: '03080000001',
        address: 'Kaaryal',
        branchId: branch._id,
        wageType: 'hourly',
        hourlyRate: 300,
        leavesPerMonth: 2,
        isActive: true,
        isApproved: true,
        joinDate: new Date(),
      },
      {
        name: 'HR Kaaryal',
        email: 'hr.kaaryal@almadina.com',
        password: hashedPassword,
        role: 'hr',
        phone: '03080000002',
        address: 'Kaaryal',
        branchId: branch._id,
        wageType: 'monthly',
        monthlyRate: 45000,
        leavesPerMonth: 2,
        isActive: true,
        isApproved: true,
        joinDate: new Date(),
      },
    ];

    console.log('\n👥 Creating branch 2 users...');
    const createdUsers = [];

    for (const userData of usersToCreate) {
      const existing = await User.findOne({ email: userData.email });
      if (existing) {
        console.log(`   ⏭️  Skipped (already exists): ${userData.email}`);
        continue;
      }
      const user = await User.create(userData);
      createdUsers.push(user);
      console.log(`   ✅ Created: ${user.name} (${user.email}) — role: ${user.role}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('🎉 BRANCH 2 SEED COMPLETE!');
    console.log('='.repeat(60));
    console.log(`\n   Branch  : ${branch.name}`);
    console.log(`   Users created this run : ${createdUsers.length}`);
    console.log('\n🔑 DEFAULT PASSWORD: password123');
    console.log('📧 Cashier : cashier.kaaryal@almadina.com');
    console.log('📧 HR      : hr.kaaryal@almadina.com');
    console.log('='.repeat(60));

    process.exit(0);
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    process.exit(1);
  }
};

addBranch2();