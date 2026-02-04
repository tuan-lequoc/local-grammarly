package grammar

import (
	"strings"

	"local-grammarly/internal/ollama"
)

/*
ErrorItem represents a single grammar issue.
- Original: text in original sentence
- Correct : suggested replacement (empty = delete)
- Start/End: byte index in original text
*/
type ErrorItem struct {
	Type     string `json:"type"`
	Original string `json:"original"`
	Correct  string `json:"correct"`
	Start    int    `json:"start"`
	End      int    `json:"end"`
}

// Result is returned to frontend
type Result struct {
	Errors []ErrorItem `json:"errors"`
}

// Service provides grammar analysis
type Service struct{}

func NewService() *Service {
	return &Service{}
}

/*
Analyze flow:
1. Ask LLM to return corrected sentence ONLY
2. Diff original vs corrected (git-like)
3. Convert diff into Grammarly-style errors
*/
func (s *Service) Analyze(text string) (*Result, error) {
	prompt := buildPrompt(text)

	corrected, err := ollama.Generate(prompt)
	if err != nil {
		return nil, err
	}

	corrected = strings.TrimSpace(corrected)

	ops := diffWords(
		strings.Fields(text),
		strings.Fields(corrected),
	)

	errors := opsToErrors(text, ops)

	return &Result{Errors: errors}, nil
}

/*
Minimal prompt.
LLM is NOT responsible for indexes or JSON.
*/
func buildPrompt(text string) string {
	return `You are a grammar correction engine.

Fix grammar, spelling, and wording.
Preserve meaning and language.
Vietnamese text may be informal or without diacritics.

Rules:
- Do NOT explain.
- Do NOT apologize.
- Do NOT refuse.
- Do NOT translate.
- Do NOT add text.

Return ONLY the corrected sentence.

Text:
` + text
}

/* =========================
   Diff implementation
   ========================= */

type OpType int

const (
	Equal OpType = iota
	Replace
	Delete
	Insert
)

type Op struct {
	Type OpType
	A    string // original
	B    string // corrected
}

/*
Compute diff using LCS (same idea as git diff)
*/
func diffWords(a, b []string) []Op {
	dp := lcs(a, b)
	i, j := len(a), len(b)

	var ops []Op

	for i > 0 || j > 0 {
		if i > 0 && j > 0 && a[i-1] == b[j-1] {
			ops = append(ops, Op{Type: Equal, A: a[i-1], B: b[j-1]})
			i--
			j--
		} else if j > 0 && (i == 0 || dp[i][j-1] >= dp[i-1][j]) {
			ops = append(ops, Op{Type: Insert, B: b[j-1]})
			j--
		} else {
			ops = append(ops, Op{Type: Delete, A: a[i-1]})
			i--
		}
	}

	reverseOps(ops)
	return mergeReplace(ops)
}

/*
Merge Delete + Insert into Replace
*/
func mergeReplace(ops []Op) []Op {
	var out []Op
	i := 0

	for i < len(ops) {
		if i+1 < len(ops) &&
			ops[i].Type == Delete &&
			ops[i+1].Type == Insert {

			out = append(out, Op{
				Type: Replace,
				A:    ops[i].A,
				B:    ops[i+1].B,
			})
			i += 2
			continue
		}

		out = append(out, ops[i])
		i++
	}

	return out
}

/* =========================
   LCS helpers
   ========================= */

func lcs(a, b []string) [][]int {
	dp := make([][]int, len(a)+1)
	for i := range dp {
		dp[i] = make([]int, len(b)+1)
	}

	for i := 1; i <= len(a); i++ {
		for j := 1; j <= len(b); j++ {
			if a[i-1] == b[j-1] {
				dp[i][j] = dp[i-1][j-1] + 1
			} else if dp[i-1][j] >= dp[i][j-1] {
				dp[i][j] = dp[i-1][j]
			} else {
				dp[i][j] = dp[i][j-1]
			}
		}
	}
	return dp
}

func reverseOps(ops []Op) {
	for i, j := 0, len(ops)-1; i < j; i, j = i+1, j-1 {
		ops[i], ops[j] = ops[j], ops[i]
	}
}

/* =========================
   Convert diff → UI errors
   ========================= */

type token struct {
	Text  string
	Start int
	End   int
}

func tokenizeWithPos(text string) []token {
	var tokens []token
	start := -1

	for i, r := range text {
		if r != ' ' {
			if start == -1 {
				start = i
			}
		} else if start != -1 {
			tokens = append(tokens, token{
				Text:  text[start:i],
				Start: start,
				End:   i,
			})
			start = -1
		}
	}

	if start != -1 {
		tokens = append(tokens, token{
			Text:  text[start:],
			Start: start,
			End:   len(text),
		})
	}

	return tokens
}

/*
Convert diff ops into Grammarly-like error list
*/
func opsToErrors(original string, ops []Op) []ErrorItem {
	tokens := tokenizeWithPos(original)
	pos := 0

	var errors []ErrorItem

	for _, op := range ops {
		switch op.Type {

		case Equal:
			pos++

		case Replace:
			errors = append(errors, ErrorItem{
				Type:     "grammar",
				Original: op.A,
				Correct:  op.B,
				Start:    tokens[pos].Start,
				End:      tokens[pos].End,
			})
			pos++

		case Delete:
			errors = append(errors, ErrorItem{
				Type:     "grammar",
				Original: op.A,
				Correct:  "",
				Start:    tokens[pos].Start,
				End:      tokens[pos].End,
			})
			pos++

		case Insert:
			insertPos := tokens[pos-1].End
			errors = append(errors, ErrorItem{
				Type:     "grammar",
				Original: "",
				Correct:  op.B,
				Start:    insertPos,
				End:      insertPos,
			})
		}
	}

	return errors
}
