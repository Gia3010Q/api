# Deploy BLF V4 Coordinator len Render Free (0 dong)

1. Day 3 file server.js, index.js, package.json va render.yaml len mot repo GitHub rieng.
2. Tren Render: New > Web Service > chon repo do, plan Free.
3. Start Command: node server.js (Render tu cap bien PORT, server.js da ho tro PORT).
4. Dat bien moi truong BLF_API_KEY neu muon bat auth, roi cap nhat cung key do trong script Lua.
5. Lay URL dang https://blf-v4-coordinator.onrender.com, doi trong script:
   ["API Base URL"] = "https://blf-v4-coordinator.onrender.com"
6. Kiem tra: mo <URL>/health phai tra ok:true.

Luu y: Free tier ngu sau 15 phut khong co request, thuc lai ~60 giay,
va state in-memory se mat khi ngu. Chi phu hop choi lien tuc / test,
khong phai chay 24/7 tin cay.
