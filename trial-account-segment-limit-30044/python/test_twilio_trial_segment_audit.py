from twilio_trial_segment_audit import segment_plan, tally, verdict


def test_one_hundred_and_sixty_ascii_characters_is_one_gsm7_segment():
    p = segment_plan("a" * 160)
    assert p["encoding"] == "GSM-7"
    assert p["segments"] == 1
    assert p["per_segment"] == 160


def test_one_more_character_drops_the_budget_to_153():
    p = segment_plan("a" * 161)
    assert p["per_segment"] == 153
    assert p["segments"] == 2


def test_a_single_emoji_flips_the_whole_body_to_ucs2():
    p = segment_plan("Welcome aboard")
    assert p["encoding"] == "GSM-7"
    p = segment_plan("Welcome aboard \U0001F389")
    assert p["encoding"] == "UCS-2"
    assert p["per_segment"] == 70


def test_an_emoji_counts_as_two_utf16_units():
    # A character count would say 1 here and agree the body fits.
    assert segment_plan("\U0001F389" + "a" * 69)["segments"] == 2


def test_the_euro_sign_stays_gsm7_and_costs_two():
    p = segment_plan("\u20ac" * 80)
    assert p["encoding"] == "GSM-7"
    assert p["units"] == 160
    assert p["segments"] == 1


def test_a_curly_apostrophe_is_not_gsm7():
    assert segment_plan("we\u2019re open")["encoding"] == "UCS-2"
    assert segment_plan("we're open")["encoding"] == "GSM-7"


def test_tally_counts_only_outbound_rejections():
    rows = [
        {"direction": "outbound-api", "error_code": "30044", "num_segments": "3",
         "sid": "SM1"},
        {"direction": "outbound-api", "error_code": 30044, "num_segments": 1,
         "sid": "SM2"},
        {"direction": "inbound", "error_code": 30044, "sid": "SM3"},
        {"direction": "outbound-api", "error_code": None, "sid": "SM4"},
    ]
    stats = tally(rows)
    assert stats["total"] == 3
    assert stats["blocked"] == 2
    assert stats["multi_segment"] == 1
    assert stats["sids"] == ["SM1", "SM2"]


def test_trial_account_with_rejections_is_blocked():
    state, detail = verdict({"type": "Trial", "status": "active"},
                            {"total": 40, "blocked": 12, "multi_segment": 12})
    assert state == "trial-blocked"
    assert "no amount of retrying" in detail


def test_trial_account_with_no_rejections_is_still_exposed():
    state, _ = verdict({"type": "Trial", "status": "active"},
                       {"total": 40, "blocked": 0, "multi_segment": 0})
    assert state == "trial-exposed"


def test_30044_on_a_paid_account_means_the_wrong_account_is_being_read():
    state, detail = verdict({"type": "Full", "status": "active"},
                            {"total": 40, "blocked": 3, "multi_segment": 3})
    assert state == "unexpected"
    assert "different account" in detail
