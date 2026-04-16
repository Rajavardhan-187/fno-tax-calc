# F&O Tax Calculator

**An ITR-3 ready tax calculator for Indian F&O traders** — Upload your Groww reports, auto-calculate tax liability, and export PDF summaries.

🚀 **Live**: https://rajavardhan-187.github.io/fno-tax-calc/

UI Images:
<img width="1919" height="953" alt="image" src="https://github.com/user-attachments/assets/cfa872a8-3c87-4709-800e-d773e15fbf87" />
<img width="1586" height="917" alt="image" src="https://github.com/user-attachments/assets/a3743257-b82f-4e70-bb5c-de8be23aa53f" />
<img width="1605" height="794" alt="image" src="https://github.com/user-attachments/assets/cd79657a-c0a7-4b52-b7e8-475619969376" />

---

## Features

✅ **Excel Upload** — Import Groww F&O P&L reports (`.xlsx`)  
✅ **ICAI 8th Edition Tax Calculation** — Turnover, deductible charges, tax audit triggers  
✅ **Multi-File Support** — Combine trades from multiple Excel files  
✅ **Loss Carry-Forward Tracking** — Track 8-year loss ledger with localStorage persistence  
✅ **Capital Gains** — Upload & reconcile separate capital gains reports  
✅ **PDF Export** — Generate professional tax summary reports  
✅ **Share Links** — Create read-only summaries via URL hash (no backend)  
✅ **Dark/Light Mode** — Beautiful Nikitin-style UI  

---

## Tax Features

### Turnover Calculation
- **Futures Turnover** = Sum of |gross P&L| per trade
- **Options Turnover** = Sum of |gross P&L| per trade  
- Automated per ICAI 8th Edition (Aug 2022) guidelines

### Deductible Charges
- STT, Brokerage, Exchange Transaction Charges, GST, Stamp Duty, SEBI, IPFT
- Manual additions: Internet, Software, Advisory, Depreciation, Office Rent, Other

### Tax Audit Triggers (Section 44AB)
- Turnover > ₹10 Cr → Always required
- Turnover ≤ ₹10 Cr + Profit < 6% of turnover → Required if total income > ₹2.5L

### Loss Rules
- **Set-off** — Against all income except salary (Section 71)
- **Carry-Forward** — Up to 8 assessment years (Section 72)
- **Preservation** — Must file ITR before due date to preserve rights

### Advance Tax Tracking
- Quarterly installment calculator & history

---

## Tech Stack

| Technology | Purpose |
|-----------|---------|
| **React 19** | UI framework with hooks |
| **Vite** | Fast build & dev server |
| **SheetJS (xlsx)** | Excel file parsing |
| **jsPDF + jspdf-autotable** | PDF report generation |
| **SVG Charts** | Custom mini donut & bar charts |
| **Google Fonts** | Plus Jakarta Sans (UI) + IBM Plex Mono (numbers) |

---

## Usage

### 1. Upload Your F&O Report
- Click **Upload** tab
- Drag & drop or select your Groww F&O P&L Excel file
- Support for multiple files — combine trades from different periods

### 2. View Dashboard
- **Turnover Summary** — Futures vs Options breakdown
- **P&L Overview** — Gross, charges, net profit/loss
- **Tax Estimate** — Quick ITR-3 tax liability

### 3. Calculate Tax
- Go to **Tax Calculation** tab
- Enter additional income (salary, capital gains, etc.)
- Select tax regime (new/old)
- View detailed breakdown

### 4. Track Losses
- **Losses** tab → Add/edit carry-forward loss ledger
- Automatically persisted in browser storage
- Track 8-year carry-forward history

### 5. Export PDF
- Click **Generate PDF** button on Dashboard
- Download professional tax report with all calculations

### 6. Share Read-Only Summary
- Click **Share** button
- Copy link — share with CA/accountant
- No backend needed; all data in URL hash

---

## Local Development

### Setup
```bash
# Clone repo
git clone https://github.com/Rajavardhan-187/fno-tax-calc.git
cd fno-tax-calc

# Install dependencies
npm install

# Start dev server
npm run dev
```
Server runs at `http://localhost:5173`

### Build for Production
```bash
npm run build
```
Output: `dist/` folder (deployed to GitHub Pages)

### Deployment
The app auto-deploys to GitHub Pages on every push to `main` via GitHub Actions.  
Workflow file: `.github/workflows/deploy.yml`

---

## Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

**Note:** Requires modern JS (ES2020+). IE11 not supported.

---

## Data Privacy

✅ **No Backend** — All data stays in your browser  
✅ **No Cloud** — Excel files never uploaded anywhere  
✅ **Local Storage Only** — Loss ledger persisted locally  
✅ **Share Links** — Compressed state in URL hash (shareable, but encrypted in URL)  

---

## Common Issues

**Q: Why is my file not parsing?**  
A: Ensure it's a Groww F&O P&L report in `.xlsx` format. Column headers must match: Date, NSE Symbol, Product, P&L, Charges, etc.

**Q: How do I preserve my loss ledger?**  
A: It's auto-saved in browser localStorage. Don't clear browser data, or losses will reset.

**Q: Can I use this on mobile?**  
A: Yes! Responsive design works on tablets and phones.

**Q: Is this an official Groww tool?**  
A: No. Independent third-party calculator. Use at your own risk for tax planning.

---

## License

MIT — Feel free to fork & modify

---

## Disclaimer

**This is a reference calculator, not tax advice.** Calculations are based on ICAI 8th Edition guidelines (Aug 2022) but tax laws change. Always verify with a qualified Chartered Accountant (CA) before filing your ITR.

We are not liable for any errors or omissions in calculations.
