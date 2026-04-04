# Macro Analyzer — Project Instructions

## Project Purpose
Track daily food intake and calculate macronutrients (calories, protein, carbs, fat, fiber) from meals. Summaries are stored per day and linked to meal photos.

---

## Users

This project tracks two users:

| User | Folder prefix | Notes |
|------|--------------|-------|
| **Chi-Hoong** (default) | top-level (`meals/`, `summaries/`) + `web/ch/` | Primary user |
| **JT** | `jt/meals/`, `jt/summaries/` + `web/jt/` | Secondary user |

When the user says "log for JT" or "JT had…", use JT's folder and targets. Otherwise default to Chi-Hoong.

`recipes/` is **shared** between both users.

---

## Folder Structure

```
macro_analyzer/
├── meals/           # Chi-Hoong's meal photos
├── recipes/         # Shared recipe files
├── summaries/       # Chi-Hoong's daily summaries (.md and .html)
├── jt/
│   ├── meals/       # JT's meal photos
│   └── summaries/   # JT's daily summaries (.md and .html)
└── web/             # All public HTML (shared index + per-user folders)
    ├── index.html   # Shared index for both users
    ├── og-image.png
    ├── ch/          # Chi-Hoong's daily HTML pages
    │   ├── meal_pics/
    │   └── YYYYMMDD.html
    └── jt/          # JT's daily HTML pages
        ├── meal_pics/
        └── YYYYMMDD.html
```

---

## meals/ — Naming Convention

All meal photos must be renamed using metadata extracted from the image's EXIF date:

```
YYYYMMDD-[Meal].jpeg
```

- `YYYY` = 4-digit year (e.g. 2026)
- `MM`   = 2-digit month (e.g. 03)
- `DD`   = 2-digit day (e.g. 30)
- `[Meal]` = one of: `Breakfast`, `Lunch`, `Dinner`, `Drink`, `Other`

If a file does not follow this format, extract the date from EXIF metadata using Python (Pillow) and ask the user to confirm the meal type before renaming.

**Example:** `20260330 - Lunch.jpeg`

---

## recipes/ — Format

Each recipe is a Markdown file. Recipes should contain at minimum an ingredients list with quantities in grams (or ml for liquids).

**Example:** `breakfast oats.md`

When a user logs a meal that matches a recipe name, **always load the recipe file first** and use its ingredient list as the basis for macro calculation. Do not estimate from memory if a matching recipe file exists.

If ingredients are missing quantities or macro data cannot be reliably derived, flag it to the user.

---

## summaries/ — Format

One file per day, named `YYYYMMDD.md` (e.g. `20260330.md`).

Each summary must include:
- Overview of meals for the day
- A per-meal breakdown table (item, cal, protein, carbs, fat, fiber)
- A meal subtotal row
- A day total table with macro % split (protein / carbs / fat)
- A disclaimer noting values are estimates
- A link to any associated meal photos in `../meals/`

Macro % split is calculated from calories:
- Protein: protein_g × 4 ÷ total_cal
- Carbs: carb_g × 4 ÷ total_cal
- Fat: fat_g × 9 ÷ total_cal

---

## Macro Calculation Rules

1. **Recipe match first** — if the meal name matches a file in `recipes/`, load that file and compute macros from its ingredients.
2. **USDA estimates** — for items without a recipe, use USDA nutritional data as the reference.
3. **Black coffee** — 2 cal, 0.3g protein, 0g carbs, 0g fat (negligible, always include for completeness).
4. **Guacamole default portion** — 50g unless stated otherwise.
5. **Rye bread default** — 30g per slice.
6. **Eggs default** — large egg = 50g.
7. All values rounded to 1 decimal place.
8. Always flag when a value is an estimate vs. derived from a recipe.

---

## Profiles & Daily Targets

### Chi-Hoong (default)

- **Age:** 46 | **Sex:** Male | **Weight:** 72kg | **Height:** 5'8" (172.7cm)
- **BMI:** 24.1 | **BMR:** ~1,574 cal/day | **TDEE:** ~2,715 cal/day (×1.725 very active)
- **Goal:** Lose belly fat (moderate deficit)

| Macro | Target | Notes |
|-------|--------|-------|
| Calories | 2,000 cal | TDEE minus ~715 kcal deficit |
| Protein | 130g | ~1.8g/kg — muscle preservation |
| Carbs | 205g | ~41% of calories |
| Fat | 74g | ~33% of calories |
| Fiber | 30g | Adult male recommendation |

---

### JT

- **Age:** 42 | **Sex:** Female | **Weight:** 110 lb (49.9kg) | **Height:** 5'4" (162.6cm)
- **BMI:** 18.9 | **BMR:** ~1,144 cal/day | **TDEE:** ~1,773 cal/day (×1.55 moderately active, 3×/week)
- **Goal:** Maintenance (update if goal changes)

| Macro | Target | Notes |
|-------|--------|-------|
| Calories | 1,773 cal | TDEE maintenance |
| Protein | 80g | ~1.6g/kg — active female |
| Carbs | 231g | ~52% of remaining calories |
| Fat | 59g | ~30% of calories |
| Fiber | 25g | Adult female recommendation |

Include a **remaining** row in each daily summary table showing how much is left vs. the respective user's targets.

---

## web/ — HTML Output

After every update to a daily summary, automatically:
1. Generate (or regenerate) the day's HTML page and save it to:
   - Chi-Hoong: `summaries/YYYYMMDD.html` AND `web/ch/YYYYMMDD.html`
   - JT: `jt/summaries/YYYYMMDD.html` AND `web/jt/YYYYMMDD.html`
2. Update `web/index.html` (shared for both users) to include a row for the day in the correct user section (`#section-ch` or `#section-jt`). CH daily pages link via `ch/YYYYMMDD.html`; JT daily pages link via `jt/YYYYMMDD.html`. Include: date, meals logged, total kcal, protein, and a fat warning if over target.
3. Copy any meal photos for the day from the user's `meals/` folder to their web `meal_pics/` folder:
   - Chi-Hoong: `meals/` → `web/ch/meal_pics/`
   - JT: `jt/meals/` → `web/jt/meal_pics/`

Design tokens for HTML pages (warm Manrope style):
- Background: `#ffffe7`, cards: `rgba(0,0,0,0.04)`, borders: `rgba(0,0,0,0.08)` / `1.5px solid #000` for section dividers
- Over-target red: `#c0392b`, positive green: `#1a7a40`
- Font: Manrope (Google Fonts), weights 300–800
- Over-target values displayed in red (`#c0392b`)
- Progress bars per macro vs. target (black fill, red if over)

**Meal photos:**
- If a meal photo exists in the user's `meals/` folder for the day, copy it to `web/{user}/meal_pics/` and embed it in the HTML above the ingredient table for that meal.
- Photos are rendered as **88×88px thumbnails** (`object-fit: cover`, `border-radius: 6px`, `cursor: zoom-in`).
- Clicking a thumbnail opens a **lightbox overlay** (dark backdrop, full-size image, close on click/Escape/✕ button).
- The `summaries/` copy uses path `../web/ch/meal_pics/FILENAME` (CH) or `../web/jt/meal_pics/FILENAME` (JT).
- The `web/ch/` and `web/jt/` copies use `meal_pics/FILENAME`.
- All daily HTML pages include a back-link to `../index.html`.

---

## Notes

- Summaries are cumulative — update the day's file as new meals are logged, do not create a new file per meal.
- If a meal photo exists for the day, link it in the summary.
- Do not delete or overwrite existing summary data when appending new meals — append a new meal section.
