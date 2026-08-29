from twilio_verify_code_length_audit import (keyspace, starts_for_even_odds,
                                              verdict)


def test_four_digits_is_ten_thousand_codes():
    state, detail = verdict({"code_length": 4})
    assert state == "short"
    assert "10000 codes" in detail
    assert "1000 fresh starts" in detail


def test_five_digits_is_below_the_bar_without_being_the_headline():
    state, detail = verdict({"code_length": 5})
    assert state == "thin"
    assert "100000 codes" in detail


def test_six_digits_passes():
    state, detail = verdict({"code_length": 6})
    assert state == "ok"
    assert "1000000 codes" in detail


def test_custom_code_outranks_a_perfectly_good_length():
    # The field still reads 6. It describes nothing that gets sent.
    state, detail = verdict({"code_length": 6, "custom_code_enabled": True})
    assert state == "custom-code"
    assert "your own application" in detail


def test_a_length_twilio_cannot_issue_is_unknown_not_safe():
    assert verdict({"code_length": 12})[0] == "unreadable"
    assert verdict({})[0] == "unreadable"
    assert verdict({"code_length": "six"})[0] == "unreadable"


def test_even_odds_spends_five_guesses_per_start():
    assert starts_for_even_odds(10000) == 1000
    assert starts_for_even_odds(1000000) == 100000
    assert starts_for_even_odds(None) is None


def test_keyspace_covers_the_range_and_rejects_the_rest():
    assert keyspace(4) == 10000
    assert keyspace(10) == 10 ** 10
    assert keyspace(3) is None
    assert keyspace(None) is None
