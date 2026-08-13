const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const MONGODB_URI = 'mongodb+srv://SwitchEats:Switcheats%40123@switcheatscluster.gcdsjg0.mongodb.net/switcheatsdb?retryWrites=true&w=majority';

async function createAdmin() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB.');

    const adminCollection = mongoose.connection.collection('food_admins');
    const existingAdmin = await adminCollection.findOne({ email: 'admin@switcheats.com' });
    
    if (existingAdmin) {
      console.log('Admin already exists! (Email: admin@switcheats.com)');
      // Re-hash and force update password
      const newHash = await bcrypt.hash('admin123', 10);
      await adminCollection.updateOne(
        { email: 'admin@switcheats.com' }, 
        { $set: { password: newHash } }
      );
      console.log('Updated existing admin password to: admin123');
    } else {
      const hash = await bcrypt.hash('admin123', 10);
      await adminCollection.insertOne({
        email: 'admin@switcheats.com',
        password: hash,
        name: 'Super Admin',
        phone: '9999999999',
        profileImage: '',
        fcmTokens: [],
        fcmTokenMobile: [],
        role: 'ADMIN',
        isActive: true,
        servicesAccess: ['food', 'quickCommerce', 'taxi'],
        createdAt: new Date(),
        updatedAt: new Date()
      });
      console.log('Successfully created a new admin account!');
      console.log('Email: admin@switcheats.com | Password: admin123');
    }
  } catch (err) {
    console.error('Error creating admin:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

createAdmin();
