package com.talorys.keyboard.suggest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SpatialModelTest {

    private val keys = mapOf('q' to Pt(0.5f, 0.5f), 'w' to Pt(1.5f, 0.5f), 'e' to Pt(2.5f, 0.5f))

    @Test fun touchDeepInsideAKeyNeverMoves() {
        // Language model strongly wants 'w', but the finger is in the middle of 'q'.
        val p = SpatialModel.pickKey('q', Pt(0.6f, 0.5f), core = 0.2f, candidates = keys, nextChar = mapOf('w' to 0.99f, 'q' to 0.001f))
        assertEquals('q', p)
    }

    @Test fun borderTouchGoesToTheLikelyKey() {
        // On the q|w border: the language model decides.
        val p = SpatialModel.pickKey('q', Pt(0.98f, 0.5f), core = 0.96f, candidates = keys, nextChar = mapOf('w' to 0.6f, 'q' to 0.01f))
        assertEquals('w', p)
        val p2 = SpatialModel.pickKey('w', Pt(1.02f, 0.5f), core = 0.96f, candidates = keys, nextChar = mapOf('q' to 0.6f, 'w' to 0.01f))
        assertEquals('q', p2)
    }

    @Test fun neverJumpsOverAKey() {
        // 'e' is two keys away: never chosen for a touch on q, however likely.
        val p = SpatialModel.pickKey('q', Pt(0.98f, 0.5f), core = 0.96f, candidates = keys, nextChar = mapOf('e' to 0.99f))
        assertTrue(p == 'q' || p == 'w')
    }

    @Test fun noModelMeansGeometric() {
        assertEquals('q', SpatialModel.pickKey('q', Pt(0.98f, 0.5f), 0.96f, keys, null))
    }

    @Test fun substitutionCostFollowsTheTouch() {
        val q = keys['q']!!; val w = keys['w']!!; val e = keys['e']!!
        val border = SpatialModel.substitutionCost(Pt(1.0f, 0.5f), q, w)
        val centre = SpatialModel.substitutionCost(Pt(0.5f, 0.5f), q, w)
        val far = SpatialModel.substitutionCost(Pt(0.5f, 0.5f), q, e)
        assertTrue("border $border < centre $centre", border < centre)
        assertTrue("centre $centre < far $far", centre < far)
        assertTrue(border <= 0.1f)
        assertEquals(1f, far, 0.001f)
    }

    @Test fun nextCharDistribution() {
        val d = SpatialModel.nextCharDistribution("th", sequenceOf("the" to 0f, "that" to -1f, "this" to -1.5f, "thumb" to -6f, "a" to 0f))
        assertEquals(1f, d.values.sum(), 0.001f)
        assertTrue(d['e']!! > d['a']!!)
        assertTrue(d['a']!! > d['u']!!)
    }
}
