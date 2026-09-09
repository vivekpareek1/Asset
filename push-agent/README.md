# push-agent

Ek agent jo har baar GitHub se connect karta hai, code push karta hai, aur
Render par deploy karke result batata hai. Aapke apne token par chalta hai,
isliye kisi integration ki permission ki dikkat nahi aati.

Koi npm dependency nahi. Sirf Node 20+ chahiye.

## Ek baar ka setup

**GitHub token** — Settings → Developer settings → Personal access tokens.
Fine-grained mein **Contents: Read and write**. Nayi repo bhi banwani ho to
**Administration: Read and write**. Classic token mein `repo` scope kaafi hai.

**Render API key** — Render dashboard → Account Settings → API Keys.
Sirf `deploy` aur `status` ke liye chahiye.

```bash
export GITHUB_TOKEN=ghp_xxxxxxxx
export RENDER_API_KEY=rnd_xxxxxxxx

# settings ek baar save kar lijiye
node push-agent.js init \
  --repo vivekpareek1/assetops \
  --dir ./assetops-deploy \
  --service srv-xxxxxxxx
```

Yeh `.pushagent.json` bana deta hai. Uske baad har deploy ek line hai.

## Rozana ka istemaal

```bash
node push-agent.js deploy     # push + Render deploy + live hone tak wait
node push-agent.js push       # sirf GitHub push
node push-agent.js status     # abhi kya chal raha hai
node push-agent.js deploy --dry-run   # kya jayega, sirf dikhaye
```

Pehli baar repo hi na ho to: `node push-agent.js push --create`
(private banti hai; `--public` chahiye to alag se dena hoga).

## Commands

| Command | Kaam |
|---|---|
| `push` | directory ko GitHub par push kare (default) |
| `deploy` | push kare, phir Render deploy chalaye aur natija bataye |
| `status` | Render service aur last deploy ki halat |
| `init` | `.pushagent.json` likh de |

## Options

| Option | Kaam |
|---|---|
| `--repo owner/name` | target repo |
| `--dir <path>` | kaunsi directory (default `.`) |
| `--branch <name>` | branch (default: repo ki default, warna `main`) |
| `--message <text>` | commit message |
| `--service <id>` | Render service id, jaise `srv-abc123` |
| `--create` / `--public` | repo na ho to banaye |
| `--dry-run` | sirf list dikhaye, kuch bheje nahi |
| `--no-wait` | deploy chala kar turant wapas aa jaye |
| `--timeout <sec>` | deploy ke liye kitna intezaar (default 900) |
| `--config <path>` | doosri config file |
| `--verbose` | har API call log kare |

Command line par diya hua option hamesha config se upar rehta hai.

Exit codes: `0` theek, `1` galat istemaal, `2` token/permission,
`3` API, `4` push karne ko kuch nahi, `5` deploy fail ya timeout.

## Kaise kaam karta hai

**GitHub** — Contents API ke bajaye Git Data API: blob → tree → commit → ref.
Saari files ek hi commit mein jaati hain, binary files kharab nahi hoti, aur
**ref sabse aakhir mein hilta hai** — beech mein rukne par branch adhoora
nahi chhootta.

Tree `base_tree` ke bina banta hai. Jo file local se hataayi, repo se bhi hat
jaayegi. Directory jaisi hai, repo waisi ho jaati hai.

**Render** — deploy explicitly trigger hota hai, taki uski id mil sake aur
status follow kiya ja sake. Auto-deploy on ho to bhi yeh nuksaan nahi karta.

**Deploy ki jaanch pehle** — `deploy` command service id aur `RENDER_API_KEY`
sabse pehle check karti hai, ek bhi file upload karne se pehle. Aadha kaam
karke fail hona sabse buri haalat hai.

## Kya kabhi upload nahi hota

`.git`, `node_modules`, `.DS_Store`, aur **`.env`** — chahe `.gitignore` mein
likha ho ya nahi. `.env` ka rule jaan-bujh kar hai: secrets galti se push ho
jaana sabse aam aur sabse mehngi galti hai.

Uske baad `.gitignore` padha jaata hai, par support seemit hai: exact naam,
directory naam, aur `*.ext`. `!negation`, `**`, aur nested `.gitignore` nahi
chalte. Complex rules hon to pehle `--dry-run` chala lijiye.

Symlink kabhi follow nahi hota.

## Testing

```bash
node --test agent.test.js     # 35 checks
```

Test nakli GitHub aur Render servers ke against chalte hain, isliye asli token
ke bina bhi poora flow verify hota hai: blob, tree, commit, ref, nayi repo,
khaali repo mein pehla commit, binary bytes, 5xx retry, 401/403 handling,
ignore rules, config merge aur override, deploy poll karke live hona, build
fail, timeout, aur `--no-wait`.

## Jo test nahi hua — dhyan rakhiye

Asli GitHub ya Render API ke against kabhi nahi chala, kyunki mere paas aapke
token nahi hain. Mock aur asli API mein farak reh sakta hai — khaas kar Render
ke deploy status ke naam. Pehli baar `--dry-run` chalaiye, phir `--no-wait`
ke saath deploy, phir `status`. Sab theek lage to seedha `deploy`.

Hazaron files wali repo ke liye yeh nahi bana — har file ek API call hai,
aur rate limit lag sakti hai. 50 MB se badi file GitHub leta hi nahi; agent
pehle hi rok deta hai.
