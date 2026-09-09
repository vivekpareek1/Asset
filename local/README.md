# Local build — isme aapka ASLI data hai

`assetops-local-realdata.html` mein aapki sheet ke 119 asli employee names
aur asli site names hain. Browser mein double-click karke khul jaata hai.

**Ise kisi public repo ya public server par mat daaliye.**

Yeh purani (v1) build hai: iska data browser ke andar rehta hai, isliye
- koi login nahi hai
- refresh par data bacha rehna guarantee nahi
- SVG sanitisation sirf browser mein chalti hai

Asli istemaal ke liye upar wali v2 chalaiye (`npm start`), aur apna data
Import page se load kar lijiye. Wahan login hai, data database mein rehta hai,
aur validation server par hoti hai.
