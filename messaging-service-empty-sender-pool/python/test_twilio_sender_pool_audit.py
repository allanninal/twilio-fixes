from twilio_sender_pool_audit import sender_count, verdict


def full(numbers=0, alpha=0, short=0):
    return {"phone_numbers": numbers, "alpha_senders": alpha, "short_codes": short}


def test_sender_count_separates_empty_from_unread():
    assert sender_count({"phone_numbers": []}, "phone_numbers") == 0
    assert sender_count({"phone_numbers": [{"sid": "PN1"}]}, "phone_numbers") == 1
    assert sender_count({}, "phone_numbers") is None
    assert sender_count(None, "phone_numbers") is None


def test_nothing_in_any_list_is_21704():
    state, detail = verdict(full())
    assert state == "empty"
    assert "21704" in detail


def test_an_unread_list_is_not_an_empty_pool():
    # The false positive worth preventing: somebody adds senders to a service
    # that already had them because one GET was skipped.
    state, detail = verdict({"phone_numbers": 0, "alpha_senders": 0,
                             "short_codes": None})
    assert state == "unread"
    assert "not read" in detail
    assert verdict({"phone_numbers": None})[0] == "unread"


def test_alpha_senders_only_is_21703_not_21704():
    state, detail = verdict(full(alpha=2))
    assert state == "alpha-only"
    assert "21703" in detail
    assert "21704" not in detail.replace("Not 21704", "")


def test_a_short_code_only_pool_still_sends():
    state, detail = verdict(full(short=1))
    assert state == "short-code-only"
    assert "1 short code(s)" in detail


def test_one_number_is_enough_to_be_ready():
    state, detail = verdict(full(numbers=1))
    assert state == "ready"
    assert "1 number(s)" in detail


def test_numbers_win_over_the_other_lists():
    assert verdict(full(numbers=3, alpha=1, short=1))[0] == "ready"
