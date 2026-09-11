# AssetOps v2

IT asset register with real sign-in, server-enforced roles, per-record storage
and server-side upload validation.

Node 20+ chahiye. Koi build step nahi.

## Pichhli version ki teen kamiyan — ab theek

**1. Login aa gaya.** Pehle koi authentication nahi tha aur role selector sirf
dikhawa tha. Ab scrypt-hashed passwords hain, server par sessions hain
(sign out turant kaam karta hai), aur **role server par check hota hai** — UI
sirf yeh tay karta hai ki kya dikhana hai. Har API route bina session ke 401
deta hai.

**2. SVG sanitisation ab server par chalti hai.** Pehle woh sirf browser mein
thi, isliye seedha API par request bhejkar bypass ho sakti thi. Ab magic-byte
check, corruption check, aur SVG cleaning `src/logo.js` mein hai — yaani server
par. Browser wali copy sirf turant feedback ke liye hai.

**3. Ab ek JSON document nahi, har record ki apni row hai.** Do log alag-alag
assets par kaam karein to dono ka kaam bachta hai. Ek hi asset par karein to
doosre ko **409 Conflict** milta hai aur screen par dikhta hai ki abhi kya
stored hai — chupchaap kisi ka kaam mitta nahi.

## Chalana

```bash
npm install
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' npm start
# http://localhost:10000
```

`ADMIN_PASSWORD` na dein to pehli baar ek random password bana kar **console par
ek baar** print hota hai. Default password kabhi nahi hai.

Demo data:

```bash
node seed.js          # 119 assets, 9 sites, 24 departments
```

Yeh khaali register par hi chalta hai. Bhare hue par `--force` maangta hai.

Postgres ke saath:

```bash
DATABASE_URL=postgres://... PG_SCHEMA=assetops npm start
```

Bina `DATABASE_URL` ke SQLite file use hoti hai (`data/assetops.db`).
Dono ke liye SQL ek hi hai, sirf placeholder style alag hai.

### Shared database

Yeh deployment ek **shared** Postgres database use karta hai — Render free
tier mein ek account mein ek hi free database chal sakta hai, aur yahan
pehle se ek doosre project (DMS) ka database maujood tha.

Isliye AssetOps apni saari 12 tables ek **alag Postgres schema** (`assetops`,
`PG_SCHEMA` se set hota hai) mein banata hai — `public` schema mein nahi.
Doosre project ki `users`, `settings` jaisi tables se koi naam ka takraav
nahi hota. Yeh asli Postgres ke against test kiya gaya hai: doosre project
jaisi tables banakar, AssetOps chalakar, confirm kiya ki dono ek doosre ko
chhoote tak nahi.

**Dhyan rakhein:** yeh ek hi database ka storage aur connection limit dono
projects share karte hain (free tier: 1 GB, ~sau connections). AssetOps
badhne lage to apna alag database lena behtar hoga.

## API

| Method | Path | Kaun |
|---|---|---|
| POST | `/api/auth/login` `/logout` | koi bhi |
| GET | `/api/auth/me` | signed in |
| POST | `/api/auth/password` | signed in |
| GET | `/api/bootstrap` `/api/activity` | Viewer+ |
| POST/PUT/DELETE | `/api/assets…` | Manager+ (delete: Admin) |
| POST | `/api/assets/bulk` `/api/assets/import` | Manager+ |
| — | `/api/sites` `/api/departments` `/api/companies` `/api/fields` `/api/users` | Admin |
| GET/PUT | `/api/settings/theme` | read Viewer+, write Admin |
| POST/DELETE | `/api/settings/logo` | Admin |
| GET | `/uploads/:name` | koi bhi (content-hash naam) |

Asset update mein `version` bhejna zaroori hai. Purana version bhejenge to 409
milega, saath mein abhi ki row.

## Security

- Password: scrypt (N=16384), per-user salt, constant-time compare
- Session: 256-bit random id, server par stored, 7 din, HttpOnly + SameSite=Lax
- 15 minute mein 10 galat attempt ke baad throttle
- Login ka jawab dono case mein same — account enumeration nahi
- Password badalne par baaki sab devices sign out
- User deactivate karte hi uske live sessions khatam
- Aakhri admin ko demote/deactivate/delete nahi kar sakte
- CSRF: mutations sirf `application/json` par + SameSite=Lax cookie
- Upload: magic bytes, truncation check, SVG cleaning — sab server par
- `/uploads` par `nosniff`, sandbox CSP, aur immutable cache

## Client build

`public/index.html` repo mein committed hai, kyunki server usi ko seedha serve
karta hai — deploy par koi build step nahi chalta.

Client ka source `client-src/` mein hai. Kuch badlein to:

```bash
npm run build          # public/index.html dobara likhta hai
```

`npm test` sabse pehle `--check` chalata hai, isliye purana `public/index.html`
commit ho gaya to test wahin fail ho jayega — production mein pata nahi chalega.

## Testing

```bash
npm install
npm install --no-save jsdom@^30      # sirf browser tests ke liye
npm test
```

| File | Kya check karta hai |
|---|---|
| `tests/auth.test.js` | login, session revoke, throttle, CSRF, password rules |
| `tests/concurrency.test.js` | optimistic locking, race conditions, bulk, import |
| `tests/security.test.js` | roles, site scoping, upload validation, theme validation |
| `tests/browser.test.js` | asli browser se asli server tak poora flow |
| `tests/mfa.test.js` | 2FA enrolment, code check, recovery codes |
| `tests/recovery.test.js` | reset tokens, aur shared throttle |
| `tests/storage.test.js` | binary logo storage, custom field import |
| `tests/audit.test.js` | injection, privilege escalation, headers |
| `tests/views.test.js` | har role ke liye har screen, XSS ke saath |

Poore suite ko dono drivers par chalaya ja sakta hai:

```bash
npm test                                          # SQLite (default)
TEST_DATABASE_URL=postgres://... npm test         # asli Postgres, per-test schema
```

## Real Postgres se mila ek asli race condition

Deploy se pehle poora backend asli Postgres ke against chalaya (pehle sirf
SQLite tha, jo single-writer hone ki wajah se races chhupa deta hai). Isse
ek asli bug pakda:

Auto-generated asset tag, site code, company code, custom field label, aur
user email banate waqt "pehle check karo khaali hai kya, phir insert karo"
pattern tha. Do requests ek saath aayein to dono check pass kar jaate, phir
dono insert karte - ek fail hoti raw database error ke saath. Sabko theek
kiya: pehle wala check advisory hai, asli check ab INSERT/UPDATE par hai -
collision par saaf 409, raw error nahi.

Import ke andar aur bhi bura tha - Postgres mein ek statement fail hone par
poori transaction abort ho jaati hai (SQLite aisa nahi karta). SAVEPOINT
laga kar fix kiya, taaki ek row skip ho, poora batch na toote.

Verify kiya asli Postgres par: 6 clients se ek saath same site code
bhejwaya - exactly ek jeetta hai, baaki saaf 409 dete hain. Import aur live
asset-creation ek saath chalakar bhi check kiya.

## Seed data mein ek deploy-crashing bug tha

Asset ke serial column par ek UNIQUE INDEX lagaya suraksha ke liye (dekhein
"Smart import matching" niche). Test karte waqt pata chala ki seed data
mein khud ek duplicate serial tha (mere apne synthetic serial-generator ka
collision) - do assets ek hi serial ke saath. Isse pehli boot par hi app
crash ho jaata, kyunki CREATE UNIQUE INDEX existing duplicate data ke saath
fail hota hai.

Do fix kiye:
1. Seed data se duplicate hataya.
2. Migration ko resilient banaya - ab agar kisi purane database mein pehle
   se duplicate data hai, app crash nahi hoga. Ek warning log hoga, aur
   baaki sab kaam karega. Dono SQLite aur Postgres par real duplicate data
   ke saath test kiya gaya hai.

## Smart import matching

Jab file upload karein, matching is priority se hoti hai:

1. Asset tag se match - agar tag diya hai aur match hota hai, update.
2. Serial number se match - tag nahi diya, par serial match karta hai, to
   update. Do alag assets ka serial same nikle, to safe side lekar skip kar
   diya jaata hai.
3. Kuch match nahi - naya asset ban jaata hai.

Serial ambiguous nikle, ya file ke andar hi ek row doosri se duplicate ho,
to woh row skip hoti hai aur kyun skip hui yeh saaf batati hai.

Import ke baad ek naya results screen dikhta hai - har row ka result
(Added / Updated / Skipped) aur wajah. Khaali cell purani value nahi
mitati - sirf jo naya value diya hai woh update hota hai.

## Apne hi workflow mein ek bug pakda

Client code do jagah tha - project root aur client-src/ folder mein alag
copy. Build script hamesha client-src/ se banata tha. Is turn mein root
files edit kiye bina client-src/ sync kiye - naya import-results feature
silently build se gayab ho gaya tha.

Pakad kar theek kiya: ab sirf client-src/ hi source hai, root par koi
duplicate copy nahi. Yeh sirf is turn ke kaam ko affect karta tha - pehle
deliver ki gayi zip files theek thi, kyunki un turns mein client-side files
touch hi nahi hui thi.

## Sign-in aur recovery

**Two-step sign-in (2FA)** — header mein "Security" par click kariye. Secret
authenticator app mein daaliye, code type kariye, on ho jayega. 10 recovery
codes ek baar dikhte hain — sirf unke hashes store hote hain, dobara nahi mil
sakte. Har code ek baar chalta hai.

TOTP khud implement kiya hai (RFC 6238), koi dependency nahi. RFC 4226 ke
official test vectors se verify kiya gaya hai.

**Password bhool gaye** — koi mail server nahi hai, isliye admin token issue
karta hai (Portal users → Reset token). Token ek baar dikhta hai, ek ghante
mein expire hota hai, ek hi baar chalta hai. Database mein sirf hash jaata
hai. Redeem karne par uss account ke saare live sessions khatam ho jaate hain.

Admin token aapko kisi bharose ke channel se dena hoga — app khud nahi bhejti.

## Jo abhi bhi baaki hai

- **Postgres path locally test nahi hua** — yahan Postgres available nahi tha.
  SQL simple hai aur dono drivers ek hi SQL chalate hain, par pehli deploy ke
  baad `/api/health` par `"store":"postgres"` check kar lijiye. Binary column
  ka type driver ke hisaab se badalta hai (SQLite `BLOB`, Postgres `BYTEA`) —
  SQLite side test ho chuka hai.
- **Email nahi bhejti.** Reset token admin ke haath se jaata hai, aur naye
  user ka password bhi admin hi set karta hai. SMTP jodna ho to
  `POST /api/users/:id/reset-token` wahi hai jahan hook lagega.
- **Logo abhi bhi database mein** hai, par ab binary (base64 nahi) — 33 percent
  jagah bachti hai aur `Content-Length` sahi jaata hai. Bahut zyada files
  hongi to object storage behtar rahega; `src/settings.js` mein woh ek jagah
  badalni hogi.
- **2FA sirf apne account par** set kar sakte hain. Admin doosre ka 2FA reset
  nahi kar sakta — abhi recovery code hi raasta hai.

## Ek audit chalaya, race condition mila

Deploy se pehle poora backend **asli Postgres** ke against chalaya (pehle
sirf SQLite tha, jo single-writer hone ki wajah se races chhupa deta hai).
Isse ek asli bug pakda:

**Auto-generated asset tag banate waqt, do requests ek saath aayein to dono
"yeh tag khaali hai" dekh lete the, phir dono insert karte — ek fail hoti
thi raw database error ke saath**, jo client tak leak ho sakta tha. Yehi
pattern site code, company code, custom field label, aur user email banane
mein bhi tha.

Sabko theek kiya: pehle wala check advisory hai, asli check ab INSERT/UPDATE
par hai — agar collision ho, toh saaf 409 milta hai, raw error nahi. Import
ke andar, Postgres transactions poore batch ko abort kar dete hain agar ek
row fail ho (SQLite aisa nahi karta) — isliye SAVEPOINT lagaya taaki ek row
skip ho, poora import na toote.

Verify kiya: 5-8 concurrent requests bhejkar — exactly ek jeetta hai, baaki
saaf 409 dete hain, koi crash nahi. Import aur live asset-creation ek saath
chalakar bhi — dono sahi rehte hain, koi duplicate tag nahi banta.

## Pichhli chetavniyan — ab band

| Pehle | Ab |
|---|---|
| Koi login nahi, role sirf dikhawa | scrypt passwords, server-side sessions, har route par role check |
| SVG sanitisation sirf browser mein | server par, `src/logo.js` mein |
| Ek JSON document, last write wins | har record ki apni row, version check ke saath 409 |
| Login throttle har process ka apna | database mein shared counter |
| Logo base64 mein | binary column (`BLOB` / `BYTEA`) |
| Custom field values import nahi hote | import hote hain, sirf declared keys |
| Password reset aur 2FA nahi | TOTP 2FA + recovery codes, admin-issued reset tokens |

## Audit mein jo mila aur theek hua

Git par daalne se pehle ek audit chalaya. Chaar cheezein nikleen:

1. **Reset endpoint par koi rate limit nahi thi.** Token 24 random bytes ka hai
   isliye guess karna waise bhi bekaar tha, par khula endpoint chhodna theek
   nahi. Ab throttle hai.
2. **Logout cookie par `Secure` nahi lagta tha** HTTPS par. Jo cookie hata rahe
   hain uske attributes wahi hone chahiye jo lagate waqt the.
3. **`must_change` flag set to hota tha par kuch karta nahi tha.** Ab temporary
   password wale user ko sign in karte hi password badalne ka dialog milta hai.
4. **Over-length input chupchaap kat jaata tha.** `TOOLONGSITECODE!!` pehle 12
   chars mein cut hokar `TOOLONGSITEC` ban jaata aur accept ho jaata — user ne
   jo type kiya woh store hi nahi hota. Ab site code, company code, department
   name, field label, user name/email aur asset tag — sab over-length par saaf
   error dete hain. Model/CPU jaise free-text fields abhi bhi trim hote hain,
   kyunki woh kisi cheez ki pehchaan nahi hain.

## Jo abhi bhi baaki hai

- **Postgres path locally test nahi hua** — yahan Postgres available nahi tha.
  SQL simple hai aur dono drivers ek hi SQL chalate hain, par pehli deploy ke
  baad `/api/health` par `"store":"postgres"` check kar lijiye. Binary column
  ka type driver ke hisaab se badalta hai (SQLite `BLOB`, Postgres `BYTEA`) —
  SQLite side poora test ho chuka hai.
- **Email nahi bhejti.** Reset token admin ke haath se jaata hai, naye user ka
  password bhi admin set karta hai. SMTP jodna ho to
  `POST /api/users/:id/reset-token` wahi hook point hai.
- **Logo abhi bhi database mein**, par binary. Bahut zyada files hongi to
  object storage behtar; `src/settings.js` mein ek jagah badalni hogi.
- **2FA sirf apne account par.** Admin doosre ka 2FA reset nahi kar sakta —
  abhi recovery code hi raasta hai.
- **Login throttle ab shared hai, par email+IP par.** Ek hi email ko alag-alag
  IP se target karna abhi bhi mumkin hai. Sirf-email wala counter jodna
  aasan hai, par usse ek attacker kisi asli user ko lock kar sakta hai — isliye
  jaan-bujh kar nahi jodda.
