from twilio_tollfree_pool_audit import is_toll_free, verdict


def pn(number):
    return {"phone_number": number, "sid": "PN" + number[-4:]}


def test_every_toll_free_area_code_is_recognised():
    for area in ("800", "833", "844", "855", "866", "877", "888"):
        assert is_toll_free("+1" + area + "5550123"), area


def test_a_uk_freephone_number_is_not_north_american_toll_free():
    # +44 800 is freephone in the UK and nothing to do with this rule.
    assert not is_toll_free("+448001234567")


def test_a_subscriber_number_containing_800_is_not_toll_free():
    assert not is_toll_free("+12028005550")
    assert not is_toll_free("+15558675309")


def test_formatting_does_not_change_the_answer():
    assert is_toll_free("+1 (833) 555-0123")
    assert is_toll_free("18335550123")


def test_one_toll_free_number_is_the_recommended_shape():
    state, detail = verdict([pn("+18005550123"), pn("+12025550100")])
    assert state == "single-toll-free"
    assert "+18005550123" in detail


def test_two_toll_free_numbers_in_one_pool_is_the_finding():
    state, detail = verdict([pn("+18005550123"), pn("+18445550199")])
    assert state == "multiple-toll-free"
    assert "snowshoeing" in detail
    assert "+18445550199" in detail


def test_a_pool_of_long_codes_is_not_this_note():
    assert verdict([pn("+12025550100"), pn("+12025550101")])[0] == "no-toll-free"


def test_an_empty_pool_points_at_the_other_note():
    state, detail = verdict([])
    assert state == "empty"
    assert "21704" in detail
