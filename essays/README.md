# Fall 2027 application essays

- `fall-2027-answers.md`: working version of all 95 answers (15 programmes), with full notes in brackets for the details still to fill in. The commit history shows the original 8 Oct draft and the refinement as a diff.
- `counsellor/`: the copy for the counsellor. The main version is a Google Doc in Karan's Drive (same folder as the earlier drafts), titled "Karan Chaudhary - Fall 2027 Application Essays"; `google-doc.html` is what it was made from. Word and PDF copies are here too. Same answers, with short placeholders instead of notes, no instructions, and deadlines and eligibility questions on the last pages. `source.md` is the text it is built from.
- `style-guide.md`: the voice the answers follow.
- `tools/`: `count.py` (word and character counts per question), `lint.py` (limits, counts and fixed lines against the original), `overlap.py` (sentences shared between applications), `outside_diff.py`, `prodcheck.py` (flags any claim of production work), `gdoc_html.py` and `verify_gdoc.py` (build the Google Doc and check it word for word), and `counsellor_docx.py` (builds the Word file: `python3 tools/counsellor_docx.py <sections dir> <endnotes.md> <out.docx>`).
- `applications/`: one Google Doc per application. UCLA: "Karan Chaudhary - UCLA MFA Producers Program (Fall 2027)" in Karan's Drive; `ucla-google-doc.html` is what it was built from.
