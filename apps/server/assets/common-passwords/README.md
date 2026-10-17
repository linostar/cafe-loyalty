# Common passwords

`common-passwords.txt` holds the 10,000 most common passwords that pass the length rule (at least 10 characters after
NFKC), from SecLists (https://github.com/danielmiessler/SecLists, MIT licence, © Daniel Miessler):
`Passwords/Common-Credentials/10k-most-common.txt` (only 51 of its entries are long enough) followed by
`xato-net-10-million-passwords-1000000.txt` in its frequency order. Shorter entries are refused by length already.
Entries are stored after NFKC and lower-casing, one per line, no comments (a password may start with any character).
The server (apps/server/src/common-passwords.ts) reads it once at start-up and refuses a new owner or operator
password found in it, compared after NFKC and lower-casing; it never reaches a web bundle.

Regenerate (from the repo root):

```sh
base=https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials
{ curl -sSfL "$base/10k-most-common.txt"; curl -sSfL "$base/xato-net-10-million-passwords-1000000.txt"; } \
  | node -e 'const l=require("fs").readFileSync(0,"utf8").split(/\r?\n/).map(p=>p.normalize("NFKC")).filter(p=>[...p].length>=10).map(p=>p.toLowerCase());process.stdout.write([...new Set(l)].slice(0,10000).join("\n")+"\n")' \
  > apps/server/assets/common-passwords/common-passwords.txt
```
