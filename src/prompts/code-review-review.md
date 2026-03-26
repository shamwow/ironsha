{{BASE_PROMPT}}

---

{{ARCH_PROMPT}}

---

{{DETAILED_PROMPT}}{{GUIDE_SECTION}}

---

## Previous Iterations
{{PREVIOUS_ITERATIONS}}

---

## Current Thread State
{{THREAD_STATE}}

## Instructions
Review the code. Read the diff with `git diff origin/{{BASE_BRANCH}}...HEAD`. Perform BOTH architecture and detailed review in a single pass. Output a single JSON block per the format above.
