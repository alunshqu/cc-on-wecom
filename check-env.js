require('dotenv').config();
console.log('BOT_ID:', process.env.WECOM_BOT_ID);
console.log('SECRET:', process.env.WECOM_BOT_SECRET ? process.env.WECOM_BOT_SECRET.substring(0,8)+'...' : 'undefined');
