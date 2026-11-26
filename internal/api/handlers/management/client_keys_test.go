package management

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/MoeForge/moego/json"
	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/clientkeys"
)

func TestGetClientKeyUsageAllTime(t *testing.T) {
	dir := t.TempDir()
	store, err := clientkeys.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	previous := clientkeys.Default()
	t.Cleanup(func() { clientkeys.SetDefault(previous) })
	clientkeys.SetDefault(store)

	handler := &Handler{}
	router := gin.New()
	router.GET("/usage", handler.GetClientKeyUsage)
	get := func(query string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/usage?"+query, nil))
		return w
	}
	empty := get("all=1")
	var emptyBody map[string]json.RawMessage
	if err := json.Unmarshal(empty.Body.Bytes(), &emptyBody); err != nil {
		t.Fatal(err)
	}
	if empty.Code != http.StatusOK || string(emptyBody["since"]) != "null" || string(emptyBody["buckets"]) != "[]" {
		t.Fatalf("empty all-time response = %d %s", empty.Code, empty.Body)
	}

	const history = `{"buckets":[{"key_id":"older","hour":"2000-01-01T00:00:00Z","tokens":9},{"key_id":"k","hour":"2001-01-01T00:00:00Z","tokens":5}]}`
	if err := os.WriteFile(filepath.Join(dir, "client-key-usage.json"), []byte(history), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err = clientkeys.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	clientkeys.SetDefault(store)
	for _, tc := range []struct {
		query string
		count int
		key   string
		year  int
	}{
		{"all=1", 2, "older", 2000},
		{"hours=2160&all=1", 2, "older", 2000},
		{"hours=invalid&all=TrUe&key=k", 1, "k", 2001},
	} {
		t.Run(tc.query, func(t *testing.T) {
			w := get(tc.query)
			var body struct {
				Since   time.Time           `json:"since"`
				Buckets []clientkeys.Bucket `json:"buckets"`
			}
			if w.Code != http.StatusOK {
				t.Fatalf("response = %d %s", w.Code, w.Body)
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			wantSince := time.Date(tc.year, 1, 1, 0, 0, 0, 0, time.UTC)
			if !body.Since.Equal(wantSince) || len(body.Buckets) != tc.count || body.Buckets[0].KeyID != tc.key {
				t.Fatalf("usage response = %+v", body)
			}
		})
	}
	if w := get("hours=invalid&all=false"); w.Code != http.StatusBadRequest {
		t.Errorf("invalid hours with all=false = %d, want 400", w.Code)
	}
}
