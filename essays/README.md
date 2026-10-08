# Fall 2027 application essays

- `fall-2027-answers.md`: working version of all 95 answers (15 programmes), with full notes in brackets for the details still to fill in. The commit history shows the original 8 Oct draft and the refinement as a diff.
- `counsellor/`: the copy for the counsellor, as Word and PDF. Same answers, with short placeholders instead of notes, no instructions, and deadlines and eligibility questions on the last pages. `source.md` is the text it is built from.
- `style-guide.md`: the voice the answers follow.
- `tools/`: `count.py` (word and character counts per question), `lint.py` (limits, counts and fixed lines against the original), `overlap.py` (sentences shared between applications), `outside_diff.py`, and `counsellor_docx.py` (builds the Word file: `python3 tools/counsellor_docx.py <sections dir> <endnotes.md> <out.docx>`).
