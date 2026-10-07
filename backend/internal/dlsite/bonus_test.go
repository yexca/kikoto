package dlsite

import "testing"

func bonusTestPrice(value int64) *int64 { return &value }

func bonusTestProduct(code string, name string, kana string, price int64) Product {
	return Product{
		WorkNo:       code,
		MakerID:      "RG00000",
		WorkName:     name,
		WorkNameKana: kana,
		RegistDate:   "2024-01-02 00:00:00",
		RegularPrice: bonusTestPrice(price),
		CurrentPrice: bonusTestPrice(price),
	}
}

func TestPurchaseBonusHintRequiresFreeMarkedProduct(t *testing.T) {
	cases := []struct {
		name   string
		title  string
		intro  string
		price  int64
		bonus  bool
		parent string
	}{
		{name: "early purchase bonus", title: "【早期購入特典】Example Voice 1", bonus: true},
		{name: "quoted parent in intro", title: "Example Voice 1", intro: "【「Example Work」早期購入特典】特典の説明", bonus: true, parent: "examplework"},
		{name: "english marker", title: "[Early Purchase Bonus] Example Voice 1", bonus: true},
		{name: "paid product with bonus", title: "【特典付き】Example Work", price: 1100},
		{name: "free product with bonus included", title: "【購入特典付き】Example Work"},
		{name: "paid bonus marker", title: "【早期購入特典】Example Work", price: 1100},
		{name: "free product without marker", title: "Example Work"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			product := bonusTestProduct("RJ00000002", tc.title, "", tc.price)
			product.IntroShort = tc.intro
			hint, ok := PurchaseBonusHintFor(product)
			if ok != tc.bonus {
				t.Fatalf("bonus = %v, want %v", ok, tc.bonus)
			}
			if ok && hint.ParentName != tc.parent {
				t.Fatalf("parent name = %q, want %q", hint.ParentName, tc.parent)
			}
		})
	}
}

func TestPurchaseBonusSelectsParentByEvidence(t *testing.T) {
	bonus := bonusTestProduct("RJ00000002", "【早期購入特典】Example Voice 1", "エグザンプルワーク", 0)
	bonus.IntroShort = "【「Example Work」早期購入特典】"
	hint, ok := PurchaseBonusHintFor(bonus)
	if !ok {
		t.Fatal("expected a purchase bonus")
	}
	parent := PurchaseBonusCandidateFromProduct(bonusTestProduct("RJ00000001", "Example Wonderful Work", "エグザンプル　ワーク", 1100))
	sibling := PurchaseBonusCandidateFromProduct(bonusTestProduct("RJ00000003", "Example Work 2", "エグザンプルワークツー", 1100))
	sibling.ReleaseDate = "2023-06-01 00:00:00"
	otherMaker := parent
	otherMaker.Code = "RJ00000004"
	otherMaker.MakerID = "RG00001"
	otherBonus := PurchaseBonusCandidateFromProduct(bonusTestProduct("RJ00000005", "【早期購入特典】Example Voice 2", "エグザンプルワーク", 0))

	code, match, ambiguous := hint.SelectParent([]PurchaseBonusCandidate{sibling, otherMaker, otherBonus, parent})
	if code != "RJ00000001" || match != PurchaseBonusKanaMatch || ambiguous {
		t.Fatalf("selected %q %v ambiguous=%v, want RJ00000001 by kana", code, match, ambiguous)
	}

	// Without a shared reading, the quoted name and release date still match.
	hint.TitleKana = ""
	code, match, _ = hint.SelectParent([]PurchaseBonusCandidate{sibling, parent})
	if code != "RJ00000001" || match != PurchaseBonusNameMatch {
		t.Fatalf("selected %q %v, want RJ00000001 by name", code, match)
	}
	parent.ReleaseDate = "2024-02-01"
	if code, _, _ = hint.SelectParent([]PurchaseBonusCandidate{parent}); code != "" {
		t.Fatalf("selected %q despite a different release date", code)
	}
}

func TestPurchaseBonusAmbiguousParentSelectsNothing(t *testing.T) {
	hint, _ := PurchaseBonusHintFor(bonusTestProduct("RJ00000003", "【早期購入特典】Example Voice 1", "エグザンプルワーク", 0))
	first := PurchaseBonusCandidateFromProduct(bonusTestProduct("RJ00000001", "Example Work 1", "エグザンプルワーク", 1100))
	second := PurchaseBonusCandidateFromProduct(bonusTestProduct("RJ00000002", "Example Work 2", "エグザンプルワーク", 1100))
	code, match, ambiguous := hint.SelectParent([]PurchaseBonusCandidate{first, second, first})
	if code != "" || match != PurchaseBonusKanaMatch || !ambiguous {
		t.Fatalf("selected %q %v ambiguous=%v, want an ambiguous kana match", code, match, ambiguous)
	}
}
