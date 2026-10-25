"""Phrasing survives text-to-phoneme conversion without downloading weights."""
from pathlib import Path
import sys
import unittest

vendor=Path(__file__).resolve().parents[1]/'kokoro_sv'/'_vendor'
sys.path.insert(0,str(vendor))
sys.path.insert(0,str(vendor/'g2p'))
import nst_g2p
from g2p_infer import SwedishG2P as NeuralG2P
from g2p_sv import SwedishG2P, phrasing_text

class PhrasingTests(unittest.TestCase):
    def setUp(self):
        self.previous=nst_g2p._inst
        engine=object.__new__(NeuralG2P)
        engine.lex={'test':['t'], 'hej':['h'], 'vida':['v'], 'riken':['r'],
                    'mörkrets':['m'], 'dem':['d'], 'tre':['t']}
        engine.oov_count=0
        engine._neural=lambda words: {w:['a'] for w in words}
        nst_g2p._inst=engine

    def tearDown(self):
        nst_g2p._inst=self.previous

    def test_line_break_reaches_phonemes_as_comma(self):
        self.assertEqual(SwedishG2P(backend='neural',preserve_line_breaks=True)('mörkrets\nvida riken'), 'm,v r')

    def test_prose_mode_keeps_existing_line_break_behavior(self):
        self.assertEqual(SwedishG2P(backend='neural')('mörkrets\nvida riken'), 'm v r')

    def test_em_dash_reaches_model_unchanged(self):
        self.assertEqual(SwedishG2P(backend='neural')('dem —\ntre'), 'd—t')

    def test_existing_punctuation_is_not_doubled(self):
        for mark in ',;:.!?—…':
            with self.subTest(mark=mark):
                self.assertEqual(phrasing_text(f'hej{mark}\nvida'), f'hej{mark} vida')
                self.assertEqual(phrasing_text(f'hej{mark}\n\nvida'), f'hej{mark} vida')

    def test_paragraph_crlf_and_blank_edges(self):
        self.assertEqual(phrasing_text('\r\nhej\r\n\r\nvida\r\nriken\r\n'), 'hej. vida, riken')

    def test_poem_keeps_words_and_em_dash(self):
        self.assertEqual(phrasing_text('mörkrets\nvida riken\ndem —\ntre'), 'mörkrets, vida riken, dem — tre')

if __name__=='__main__':
    unittest.main()
