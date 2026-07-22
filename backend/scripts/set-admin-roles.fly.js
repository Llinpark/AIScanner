const mongoose = require("/app/node_modules/mongoose");
const UserConfig = require("/app/models/User");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const superEmail = "collinspark1985@gmail.com";
  const adminEmails = ["barasajohn1985@gmail.com", "lilianmonari15@gmail.com"];
  await UserConfig.updateOne({ email: superEmail }, { $set: { role: "super_admin" } });
  await UserConfig.updateMany({ email: { $in: adminEmails } }, { $set: { role: "admin" } });
  const users = await UserConfig.find({ email: { $in: [superEmail, ...adminEmails] } }).select("email role").lean();
  console.log(JSON.stringify(users, null, 2));
  await mongoose.disconnect();
})().catch(async (e) => { console.error(e.message); process.exit(1); });
