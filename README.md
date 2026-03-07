# 🎮 Call of Didy - APK + Multiplayer

## كيف تبني APK مجاناً من هاتفك

### الخطوة 1 — رفع على GitHub
1. روح **github.com** من متصفحك
2. اضغط **+** ← **New repository**
3. سمّيه: `call-of-didy`
4. اضغط **Create repository**
5. اضغط **uploading an existing file**
6. ارفع **كل الملفات** من هذا الـ ZIP (اضغط Select all)
7. اضغط **Commit changes**

### الخطوة 2 — GitHub يبني APK تلقائياً
1. اضغط **Actions** (في الأعلى)
2. شوف Build يشتغل تلقائياً ⚡
3. انتظر 3-5 دقائق

### الخطوة 3 — نزّل APK
1. افتح الـ Build بعد ما ينتهي ✅
2. اضغط **CallOfDidy-APK** تحت Artifacts
3. نزّل وثبّت على هاتفك! 📱

### ⚠️ مهم قبل التثبيت
في هاتفك: **الإعدادات** ← **الأمان** ← **تثبيت من مصادر غير معروفة** ← فعّل

---

## كيف تلعبون Multiplayer
1. ارفع السيرفر على **glitch.com** (ارفع server.js + package.json)
2. خذ الرابط مثل: `https://call-of-didy.glitch.me`
3. في **MainActivity.java** غيّر السطر:
   ```
   webView.loadUrl("https://call-of-didy.glitch.me");
   ```
   إلى رابط Glitch الخاص بك
4. ابني APK من جديد

---
Made with ❤️ by Bilal
