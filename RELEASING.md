# Release Orchivox, langkah demi langkah

Panduan operasional untuk publish versi baru Orchivox. Untuk detail arsitektur
release, signing, dan troubleshooting lengkap, lihat
[`docs/releasing.md`](docs/releasing.md).

## 0. Ringkasan alur

1. Siapkan environment dan secret sekali di awal.
2. Review perubahan yang akan ikut release.
3. Jalankan dry run.
4. Jalankan guided release.
5. Approve environment `release` di GitHub Actions.
6. Verifikasi GitHub Release, npm, dan update.
7. Rollback jika ada masalah.

## 1. Prasyarat awal

Pastikan yang berikut sudah siap:

- Bun 1.4.4 atau lebih baru.
- Node 20 atau lebih baru.
- GitHub CLI sudah login.
- Remote `origin` mengarah ke repository yang benar.
- Akses ke environment `release` di GitHub.
- Secret `ORCHIVOX_RELEASE_SIGNING_KEY` ada di environment `release`.
- Secret `NPM_TOKEN` ada di environment `release` dan bisa bypass 2FA.
- Public key release sudah sesuai dengan private key di
  `src/installer/release-public-key.ts`.

Periksa environment:

```bash
bun --version
node --version
gh auth status
git remote -v
gh secret list --env release
```

Kalau public key dan private key tidak cocok, update public key dulu:

```bash
bun run release:key public \
  --private ~/.config/orchivox/release-private.pem \
  --out release-public-key.pem
```

Lalu salin isi public key ke `src/installer/release-public-key.ts` dan commit
perubahannya sebelum release.

## 2. Review perubahan sebelum release

Script release menjalankan `git add -A`. Artinya semua perubahan yang tidak
di-ignore akan masuk ke commit release. Review dulu:

```bash
git status --short
git diff
git diff --stat
git branch --show-current
git fetch --tags origin
```

Kalau ada perubahan yang tidak ingin ikut release, commit atau stash dulu.
Jangan jalankan release dengan working tree yang belum kamu pahami.

File berikut di-ignore dan tidak ikut commit release:

- `PLAN*.md`
- `tests/`
- `.agent/`
- `dist/`
- Binary `orchivox`

## 3. Cek versi dan status publish

Lihat tag terakhir dan versi npm saat ini:

```bash
git tag --list "v*" | sort -V | tail -n 5
npm view orchivox version
```

Cek juga versi yang akan dipakai:

```bash
npm view orchivox@X.Y.Z version
```

Kalau perintah terakhir mengembalikan versi, berarti versi itu sudah ada di npm
dan tidak bisa dipakai lagi.

Aturan versi:

- Versi baru harus lebih besar dari tag terakhir.
- Tag harus `vX.Y.Z`.
- `package.json` dan tag harus sama. Script guided release menangani ini.
- Jangan membuat tag yang sudah ada.

## 4. Jalankan dry run

Dry run menampilkan rencana tanpa mengubah file dan tanpa push:

```bash
bun run release -- --dry-run
```

Contoh dengan versi dan pesan commit:

```bash
bun run release -- --dry-run --version 0.4.0 -m "Release 0.4.0"
```

Yang perlu dicek di output:

- Branch yang dipilih.
- Versi lama dan versi baru.
- Tag yang akan dibuat.
- Pesan commit.
- Status working tree.
- Checks yang akan dijalankan.

## 5. Jalankan guided release

Untuk alur interaktif:

```bash
bun run release
```

Script akan bertanya:

1. Branch yang akan di-release. Pilih `main` kecuali kamu memang release dari
   branch lain.
2. Pesan commit. Contoh: `Release 0.4.0`.
3. Versi: patch, minor, major, atau manual.
4. Konfirmasi sebelum mulai.

Untuk automation atau tanpa prompt:

```bash
bun run release -- --bump patch -m "Release 0.3.2" --yes
```

Ganti `0.3.2` dengan versi hasil bump yang sebenarnya. Atau dengan versi exact:

```bash
bun run release -- --version 0.4.0 -m "Release 0.4.0" --yes
```

Flag penting:

| Flag | Arti |
| --- | --- |
| `--branch <name>` | Branch yang dipakai untuk release |
| `--create-branch` | Buat branch kalau belum ada |
| `--allow-non-main` | Izinkan tag dari branch selain `main` |
| `-m, --message` | Pesan commit release |
| `--version <x.y.z>` | Versi exact |
| `--bump patch\|minor\|major` | Naikkan versi otomatis |
| `-y, --yes` | Jalankan tanpa prompt |
| `--dry-run` | Tampilkan rencana saja |
| `--no-checks` | Lewati typecheck, test, secret scan, dan pack check |
| `--no-watch` | Jangan tunggu workflow GitHub |

Jangan gunakan `--no-checks` kecuali kamu sudah menjalankan typecheck, test,
secret scan, dan pack check secara manual. Workflow CI tidak menjalankan
`bun test`.

## 6. Apa yang dilakukan guided release

Setelah kamu konfirmasi, `bun run release` akan:

1. Mengubah versi di `package.json`.
2. Mengubah baris versi di `README.md`.
3. Membangun ulang `bin/launcher.mjs`.
4. Menjalankan:
   - `bun run typecheck`
   - `bun test` jika folder `tests/` ada
   - `bun run check:secrets`
   - `bun run pack:check`
   - `git diff --check`
5. Menjalankan `git add -A` lalu commit.
6. Push branch.
7. Membuat annotated tag `vX.Y.Z`.
8. Push tag.
9. Menunggu workflow release dan menampilkan URL approval.

Kalau salah satu check gagal, release berhenti sebelum commit dan push.
Namun `package.json`, `README.md`, dan `bin/launcher.mjs` mungkin sudah berubah.
Review dan kembalikan perubahan itu sebelum mencoba lagi.

## 7. Approve environment release

Setelah tag di-push, workflow `release.yml` berjalan. Job publish menunggu
approval environment `release`.

Lewat browser:

1. Buka halaman Actions repository.
2. Pilih workflow run untuk tag yang baru.
3. Klik `Review deployments`.
4. Pilih `release`.
5. Approve.

Lewat terminal:

```bash
gh run list --workflow=release.yml
gh run view <run-id> --web
```

Approval ini diperlukan sebelum workflow bisa membaca signing key dan
`NPM_TOKEN`.

## 8. Apa yang dilakukan workflow release

Workflow menjalankan:

1. Verify:
   - install dependency
   - typecheck
   - build launcher dan cek tidak ada diff
   - pack check
   - secret scan
2. Build lima asset:
   - `orchivox-linux-x64.gz`
   - `orchivox-linux-arm64.gz`
   - `orchivox-darwin-x64.gz`
   - `orchivox-darwin-arm64.gz`
   - `orchivox-windows-x64.exe.gz`
3. Smoke test setiap binary dengan `--version`.
4. Sign `latest.json` dengan Ed25519.
5. Buat draft GitHub Release.
6. Upload asset satu per satu, termasuk `SHA256SUMS`, `latest.json`, dan
   `latest.json.sig`.
7. Publish release sebagai latest.
8. Publish package `orchivox` ke npm dengan provenance.

Catatan: workflow CI tidak menjalankan `bun test`. Test lokal dijalankan oleh
script `bun run release` jika folder `tests/` tersedia. Folder `tests/` tidak
ikut repository publik.

## 9. Verifikasi setelah publish

Cek GitHub Release:

```bash
gh release view vX.Y.Z
```

Pastikan asset berikut ada:

- `orchivox-linux-x64.gz`
- `orchivox-linux-arm64.gz`
- `orchivox-darwin-x64.gz`
- `orchivox-darwin-arm64.gz`
- `orchivox-windows-x64.exe.gz`
- `SHA256SUMS`
- `latest.json`
- `latest.json.sig`

Cek npm:

```bash
npm view orchivox@X.Y.Z version
npm view orchivox version
```

Cek installer dan update:

```bash
npx --yes orchivox@latest --version
orchivox update --check
orchivox update --check --json
```

Kalau `orchivox` belum terpasang, cukup pakai `npx` untuk smoke test.

Cek signature dan checksum:

- Installer akan memverifikasi `latest.json.sig` dan SHA-256 asset saat install
  atau update.
- Kalau verifikasi gagal, jangan bypass. Cek release dan asset yang di-upload.

## 10. Rollback

Rollback di mesin pengguna:

```bash
orchivox update --rollback
```

Rollback ini memakai versi sebelumnya yang disimpan di
`~/.orchivox/versions/`.

Kalau release-nya sendiri yang salah:

- Jangan rewrite tag yang sudah dipublikasikan.
- Hapus atau jadikan draft GitHub Release yang salah.
- Publish versi patch baru.
- Untuk npm, publish versi baru. Hindari `npm unpublish` karena bisa merusak
  pengguna yang sudah menginstall.

## 11. Troubleshooting cepat

| Gejala | Tindakan |
| --- | --- |
| `tag vX.Y.Z already exists` | Pakai versi baru. Jangan hapus tag yang sudah dipublikasikan. |
| `orchivox@X.Y.Z is already published on npm` | Naikkan versi. |
| `EOTP` saat npm publish | `NPM_TOKEN` harus bypass 2FA atau memakai automation token. |
| `E404` saat npm publish | Token npm salah atau tidak punya akses ke package. |
| `ReleaseAsset.name already exists` | Jalankan ulang job. Workflow menghapus asset lama sebelum upload. |
| Verify gagal karena `bin/launcher.mjs` berubah | Jalankan `bun run build:launcher`, commit hasilnya, lalu release ulang. |
| Installer gagal verifikasi signature | Cek `src/installer/release-public-key.ts` dan private key yang dipakai workflow. |
| Asset tidak lengkap | Jangan publish release. Jalankan ulang job build dan upload. |

## 12. Manual fallback

Kalau guided release tidak bisa dipakai, jalankan alur manual:

```bash
# 1. Pastikan bersih dan di branch yang benar
git status --short
git switch main

# 2. Jalankan checks
bun run typecheck
bun test
bun run check:secrets
bun run pack:check

# 3. Ubah versi di package.json dan README.md
#    Contoh: 0.3.1 -> 0.4.0

# 4. Build launcher
bun run build:launcher

# 5. Commit dan push
git add -A
git commit -m "Release 0.4.0"
git push origin main

# 6. Buat dan push tag
git tag -a v0.4.0 -m "Orchivox 0.4.0"
git push origin v0.4.0
```

Setelah tag di-push, approve environment `release` seperti langkah 7.

Untuk build asset lokal tanpa publish:

```bash
bun run build:release --version 0.4.0
```

Hasilnya ada di `dist/release/v0.4.0/`. Folder `dist/` tidak boleh di-commit.

Untuk sign manifest lokal:

```bash
bun run build:release --version 0.4.0 --manifest-only \
  --signing-key ~/.config/orchivox/release-private.pem \
  --require-signature
```

## 13. Checklist akhir

- [ ] Working tree sudah direview.
- [ ] Branch dan versi benar.
- [ ] Dry run sudah dicek.
- [ ] Guided release selesai sampai tag di-push.
- [ ] Environment `release` sudah di-approve.
- [ ] Workflow release hijau.
- [ ] Lima asset release ada.
- [ ] `SHA256SUMS`, `latest.json`, dan `latest.json.sig` ada.
- [ ] `npm view orchivox@X.Y.Z version` mengembalikan versi yang benar.
- [ ] `npx --yes orchivox@latest --version` menampilkan versi baru.
- [ ] `orchivox update --check` melihat versi baru.
- [ ] Release notes sudah sesuai.
- [ ] Tidak ada tag yang di-rewrite.

## 14. File terkait

- `scripts/release.ts`: guided release.
- `scripts/build-release.ts`: build asset, manifest, signature.
- `.github/workflows/release.yml`: workflow GitHub Actions.
- `docs/releasing.md`: referensi release lengkap.
- `src/installer/`: installer, update, signature, rollback.
