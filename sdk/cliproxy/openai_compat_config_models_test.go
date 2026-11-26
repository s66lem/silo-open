package cliproxy

import (
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/util"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/watcher/synthesizer"
)

func TestBuildOpenAICompatibilityConfigModels_InputModalities(t *testing.T) {
	compat := &config.OpenAICompatibility{
		Name: "mimo",
		Models: []config.OpenAICompatibilityModel{
			{
				Name:            "upstream-vision",
				Alias:           "mimo-v2.5-pro",
				DisplayName:     "Mimo Vision",
				InputModalities: []string{"TEXT", "image", "image"},
			},
			{
				Name:  "upstream-image",
				Alias: "compat-image",
				Image: true,
			},
		},
	}

	models := buildOpenAICompatibilityConfigModels(compat)
	if len(models) != 2 {
		t.Fatalf("model count = %d, want 2", len(models))
	}

	var vision *ModelInfo
	var imageModel *ModelInfo
	for _, model := range models {
		if model == nil {
			continue
		}
		switch model.ID {
		case "mimo-v2.5-pro":
			vision = model
		case "compat-image":
			imageModel = model
		}
	}
	if vision == nil {
		t.Fatal("expected vision model")
	}
	if vision.DisplayName != "Mimo Vision" {
		t.Fatalf("DisplayName = %q, want Mimo Vision", vision.DisplayName)
	}
	if got := joinModalities(vision.SupportedInputModalities); got != "text,image" {
		t.Fatalf("SupportedInputModalities = %q, want text,image", got)
	}
	if imageModel == nil {
		t.Fatal("expected image model")
	}
	if imageModel.DisplayName != "compat-image" {
		t.Fatalf("image DisplayName = %q, want compat-image", imageModel.DisplayName)
	}
	if imageModel.Type != registry.OpenAIImageModelType {
		t.Fatalf("image model type = %q, want %q", imageModel.Type, registry.OpenAIImageModelType)
	}
	if len(imageModel.SupportedInputModalities) != 0 {
		t.Fatalf("image model input modalities = %+v, want none", imageModel.SupportedInputModalities)
	}
}

func TestOpenAICompatibilityModelRegistrationExclusions(t *testing.T) {
	for _, tc := range []struct {
		name  string
		cache bool
	}{
		{name: "cached", cache: true},
		{name: "uncached"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := &config.Config{OpenAICompatibility: []config.OpenAICompatibility{{
				Name:    "u1",
				BaseURL: "https://example.invalid/v1",
				Prefix:  "ultra",
				Models: []config.OpenAICompatibilityModel{
					{Name: "claude-high", Alias: "claude-opus-5-5-high"},
					{Name: "gemini-4-carbon-high"},
				},
			}}}
			provider := util.OpenAICompatibleProviderKey("u1")
			service := &Service{cfg: cfg, pluginHost: newPluginStaticModelHost(t, provider)}
			reg := GlobalModelRegistry()
			auths, err := synthesizer.NewConfigSynthesizer().Synthesize(&synthesizer.SynthesisContext{
				Config: cfg, IDGenerator: synthesizer.NewStableIDGenerator(),
			})
			if err != nil || len(auths) != 1 {
				t.Fatalf("synthesized %d auths, err = %v", len(auths), err)
			}
			auth := auths[0]
			t.Cleanup(func() { reg.UnregisterClient(auth.ID) })

			register := func() map[string]bool {
				t.Helper()
				var cache *openAICompatibilityRegistrationCache
				if tc.cache {
					cache = newOpenAICompatibilityRegistrationCacheForConfig(cfg)
				}
				if !service.registerModelsForAuthWithConfigAndCache(t.Context(), cfg, auth, cache) {
					t.Fatal("model registration rejected")
				}
				ids := make(map[string]bool)
				for _, model := range reg.GetModelsForClient(auth.ID) {
					ids[model.ID] = true
				}
				return ids
			}
			if ids := register(); !ids["ultra/claude-opus-5-5-high"] || !ids["ultra/"+pluginStaticGlobalModel] {
				t.Fatalf("initial registration missing configured or plugin models: %v", ids)
			}
			cfg.OpenAICompatibility[0].ExcludedModels = []string{"claude-*", "plugin-*"}
			if ids := register(); len(ids) != 2 || !ids["gemini-4-carbon-high"] || !ids["ultra/gemini-4-carbon-high"] {
				t.Fatalf("registered model IDs = %v, want only Gemini in both forms", ids)
			}
			cfg.OpenAICompatibility[0].ExcludedModels = []string{"*"}
			if ids := register(); len(ids) != 0 {
				t.Fatalf("registered model IDs = %v, want none", ids)
			}
		})
	}
}

func joinModalities(modalities []string) string {
	if len(modalities) == 0 {
		return ""
	}
	out := modalities[0]
	for i := 1; i < len(modalities); i++ {
		out += "," + modalities[i]
	}
	return out
}
