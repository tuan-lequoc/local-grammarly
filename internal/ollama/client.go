package ollama

import "fmt"

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

const (
	baseURL = "http://localhost:11434/api/generate"
	// model   = "phi"
	model   = "qwen2.5:3b"
)

type request struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	Stream bool   `json:"stream"`
}

type response struct {
	Response string `json:"response"`
}

func Generate(prompt string) (string, error) {
	body, _ := json.Marshal(request{
		Model:  model,
		Prompt: prompt,
		Stream: false,
	})

	client := &http.Client{
		Timeout: 10 * time.Second,
	}

	resp, err := client.Post(baseURL, "application/json", bytes.NewBuffer(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", errors.New("ollama request failed")
	}

	raw, _ := io.ReadAll(resp.Body)

	var res response
	if err := json.Unmarshal(raw, &res); err != nil {
		return "", err
	}

	fmt.Println("Response:", res.Response) // <-- print response
	return res.Response, nil
}
