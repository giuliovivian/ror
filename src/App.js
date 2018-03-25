import React from 'react';
import _ from 'lodash';
import './App.css';

import 'bootstrap/dist/css/bootstrap.css'

import {Client} from 'boardgame.io/react';
import {Game, PlayerView} from 'boardgame.io/core';
import {Random} from 'boardgame.io/core';
import {PlayerModel} from './Player.js'
import {DeckModel} from './Deck';

import MortalityBoard from './MortalityBoard.js'
import RevenueBoard from './RevenueBoard.js'
import PopulationBoard from './PopulationBoard';
import ForumBoard from './ForumBoard';
import PlayerBoard from './PlayerBoard';
import {Neutrals} from './Neutrals.js';
import {CardModel} from './Card';
import {EventDeck} from './Event';
import GamesTable from './GamesTable';
import PopulationTable from './PopulationTable';

import RevenueBot from './RevenueBot';
import ForumBot from './ForumBot';
import Util from './Util';

const forumState = require('./data/forum.json');

const deck = new DeckModel();

const initialHands = [
    PlayerModel.getRandomSenators(deck),
    PlayerModel.getRandomSenators(deck),
    PlayerModel.getRandomSenators(deck),
    PlayerModel.getRandomSenators(deck),
    PlayerModel.getRandomSenators(deck)
]

const randomHRAOIndex = Math.round(Random.Number(14));
_.flattenDeep(initialHands)[randomHRAOIndex].addSpoil('ROME_CONSUL');

const Ror = Game({

    name: 'RoR',

    setup: () => ({

        mortalityChitsToDraw: 1,
        mortalityChits: [],

        republic: {
            treasury: 100,
            unrest: 0,
            landBills: [],
            laws: [],
            legions: 4,
            fleets: 0,
            veterans: 0,
            events: [],
            activeWars: [],
            unprosecutedWars: [],
            inactiveWars: [],
            imminentWars: [],
            stateOfRepublicSpeechExit: null
        },

        forum: {
            events: [],
            provinces: [],
            senators: [],
            concessions: []
        },

        curia: {
            senators: [],
            concessions: [],
            leaders: []
        },

        forumDeck: deck,

        playersOrder: [0, 1, 2, 3, 4],

        players: {
            0: {
                name: "Player",
                tableCards: initialHands[0],
                hand: [],
                talents: 0,
            },
            1: {
                name: "Neutral 1",
                tableCards: initialHands[1],
                hand: [],
                talents: 0
            },
            2: {
                name: "Neutral 2",
                tableCards: initialHands[2],
                hand: [],
                talents: 0
            },
            3: {
                name: "Neutral 3",
                tableCards: initialHands[3],
                hand: [],
                talents: 0
            },
            4: {
                name: "Neutral 4",
                tableCards: initialHands[4],
                hand: [],
                talents: 0
            }
        },

    }),

    moves: {

        drawMortalityChit(G, ctx) {
            let senatorsToKill = [];
            for (let i = 0; i < G.mortalityChitsToDraw; i++) {
                senatorsToKill.push(Random.Die(36));
            }
            return {...G, mortalityChits: senatorsToKill}
        },

        killSenator(G, ctx, id) {
            const game = {...G};

            for (let playerIndex in game.players) {
                let player = game.players[playerIndex];
                const foundSenatorIndex = player.tableCards.findIndex(card => card.id === id);
                if (foundSenatorIndex > -1) {
                    player.tableCards.slice(foundSenatorIndex, foundSenatorIndex + 1);
                }
            }

            return {...game}
        },

        distributeTalents(G, ctx, talentsObject) {
            const players = Object.assign({}, G.players);
            players[ctx.currentPlayer].tableCards = Object.values(talentsObject.senators);
            players[ctx.currentPlayer].talents = talentsObject.familyTalents;

            return {...G, players}
        },

        doStateContribution(G, ctx, contributor, contribution) {
            const game = Object.assign({}, G);

            if (!contributor) {
                return game;
            }

            game.republic.treasury += contribution;

            const senator = game.players[ctx.currentPlayer].tableCards
                .find(card => card.id === contributor)
            senator.talents -= contribution;

            if (contribution >= 50) {
                senator.influence += 7;
            }

            if (contribution >= 25 && contribution < 50) {
                senator.influence += 3;
            }

            if (contribution >= 10 && contribution < 20) {
                senator.influence += 1;
            }

            return {...game}

        },

        drawForumCard(G, ctx) {
            const game = {...G};
            const card = DeckModel.drawRandomCard(game.forumDeck);

            switch (card.type) {
                case 'senator':
                    game.forum.senators.push(card);
                    break;
                case 'concession':
                    game.forum.concessions.push(card);
                    break;
                default:
                    break;
            }

            return {...game}
        },

        goToGameState(G, ctx, phase, gameState) {
            return {...gameState};
        },

        drawEvent(G, ctx, id) {
            let game = {...G};

            const drawnEvent = EventDeck.find(event => event.id === id);

            game.forum.events.push(drawnEvent);
            game = drawnEvent.apply(game, ctx);

            return game;
        },

        /**
         * Your Senator chosen (in Rome) may attempt to:
         * # persuade an unaligned Senator in the Forum
         * # persuade an already Aligned non-Faction Leader Senator.
         * to join his own Faction.
         *
         * The Senator making the Persuasion Attempt
         * + Add his Oratory and
         * + Add his Influence and
         * - Subtracts the target Senator’s Loyalty rating to get a Base Number.
         * This Base Number can be modified by Loyalty (1.07.411), Bribes (1.07.412) and CounterBribes (1.07.413).
         *
         * If the target Senator is already Aligned, +7 is added to his Loyalty rating.
         * The number of Talents in the Personal Treasury of the target Senator is also added to his Loyalty rating.
         *
         * The resulting Base Number is then compared to a 2d6 roll.
         *
         * If Roll > Base Number,
         *    Persuasion Attempt succeeds => the target Senator joins the Faction of the Senator making the Persuasion Attempt.
         * If the Original (unmodified) Roll >= 10 || Modified roll is < Base Number
         *    Persuasion Attempt fails => the target Senator remains either uncommitted or aligned to his current Faction as the case may be.
         *
         * @param G
         * @param ctx
         * @param persuasor => The Senator making the Persuasion Attempt
         * @param senatorTarget
         * @param offer
         * @returns {{}}
         */
        doPersuasionAttempt(G, ctx, persuasor, senatorTarget, offer) {
            const game = {...G};
            // loyalty = loyalty + 7 (if already Aligned) + talents
            let loyaltyModifier = parseInt(senatorTarget.senator.loyalty, 10);
            loyaltyModifier += senatorTarget.senator.talents;
            if (senatorTarget.player) {
                loyaltyModifier += 7;
            }
            // base = oratory + influence - loyalty
            let base = parseInt(persuasor.oratory, 10) + parseInt(persuasor.influence, 10) - loyaltyModifier;
            base += parseInt(offer, 10);
            const roll = Random.Die(6, 2);
            const rollTotal = roll.reduce((sum, n) => sum + n, 0);
            
            if (rollTotal <= base) {
                let cards, targetIndex;
                if (senatorTarget.player) {
                    cards = game.players[senatorTarget.index].tableCards
                    targetIndex = cards.findIndex(card => card.id === senatorTarget.senator.id);
                } else {
                    cards = game.forum.senators;
                    targetIndex = cards.findIndex(card => card.id === senatorTarget.senator.id);
                }
                cards.splice(targetIndex, 1);

                const senatorCard = new CardModel(senatorTarget.senator);
                senatorCard.talents += offer;
                game.players[ctx.currentPlayer].tableCards.push(senatorCard);

            } else if (rollTotal >= 10 || rollTotal > base) {
                //const persuaded = game.players[senatorTarget.index].tableCards.find(card => card.id === senatorTarget.senator.id);
                //persuaded.talents += offer;
                senatorTarget.senator.talents += offer;
            }

            return {...game}
        },

        doAttractKnight(G, ctx, attractor, offer) {
            const game = {...G};

            game.players[ctx.currentPlayer].tableCards.find(c => c.id === attractor.id).talents -= offer;

            const base = offer + Random.Die(6);
            if (base >= 6) {
                game.players[ctx.currentPlayer].tableCards.find(c => c.id === attractor.id).knights += 1;
            } else {
                console.log('fail')
            }

            return game;
        },

        doSponsorGames(G, ctx, gameType, sponsor) {
            const game = {...G};

            const sponsoredGame = GamesTable.find(g => g.id === gameType);
            const senator = game.players[ctx.currentPlayer].tableCards.find(c => c.id === sponsor.id)

            if (senator.talents >= sponsoredGame.cost) {
                senator.talents -= sponsoredGame.cost;
                senator.popularity += sponsoredGame.popularity;
                game.republic.unrest += sponsoredGame.unrest;
            }

            return game;
        },

        doStateOfRepublicSpeech(G, ctx) {
            let game = {...G};
            const HRAOObject = Util.findHRAOOrder(G)[0];
            console.log(HRAOObject);

            const rolls = Random.Die(6, 3);
            const totalRoll = rolls.reduce((sum, r) => sum + r, 0);

            const totalResult = totalRoll + HRAOObject.card.popularity - game.republic.unrest;

            game = PopulationTable[totalResult].apply(game, ctx);
            game.republic.stateOfRepublicSpeechExit = PopulationTable[totalResult];

            return game;
        }

    },

    flow: {
        phases: [
            {
                name: 'mortality',
                onPhaseEnd: (G, ctx) => {
                    return {...G, mortalityChits: []}
                }
                // allowedMoves: ['drawMortalityChit', 'killSenator'],
            },
            {
                name: 'revenue',
                // allowedMoves: ['distributeTalents', 'doStateContribution'],
                onPhaseBegin: (G, ctx) => {

                    const game = Object.assign({}, G);

                    game.republic.treasury += 100;

                    game.players = Object.keys(game.players).map(playerIndex => {
                        const player = game.players[playerIndex];
                        player.tableCards = player.tableCards.map(card => {
                            const c = new CardModel(card);
                            c.addRevenueTalents();
                            return c;
                        })
                        return player;
                    })

                    return game;
                }
            },
            {
                name: 'forum',
                // allowedMoves: ['drawForumCard'],
                onPhaseBegin: (G, ctx) => {
                    const game = {...G};
                    game.republic.events = [];

                    // set player order
                    const HRAOOrder = Util.findHRAOOrder(G);
                    const firstPlayer = HRAOOrder[0].index;
                    const playersOrder = [];

                    let j = 0
                    while (j < Object.keys(game.players).length) {
                        playersOrder.push(firstPlayer + j % Object.keys(game.players).length);
                        j++;
                    }
                    game.playersOrder = playersOrder;

                    return game;
                },
                turnOrder: {
                    first: (G) => {
                        const HRAOOrder = Util.findHRAOOrder(G);
                        return HRAOOrder[0].index;
                    },
                    next: (G, ctx) => (ctx.currentPlayer + 1) % ctx.numPlayers
                }
            },
            {
                name: 'population',
                onPhaseBegin: (G, ctx) => {
                    const game = {...G};

                    game.playersOrder = [0, 1, 2, 3, 4];

                    return game;
                },
                onPhaseEnd: (G, ctx) => {
                    const game = {...G};
                    game.republic.stateOfRepublicSpeechExit = null;
                    return game;
                }
            },
            {
                name: 'senate',
                onPhaseBegin: (G, ctx) => {
                    const game = {...G};

                    return game;
                }
            }
        ]
    }


})

class Board extends React.Component {

    goToGameState(phase, state) {

        if (phase === 'forum') {
            this.props.events.endPhase();
            this.props.events.endPhase();
        }

        this.props.moves.goToGameState(phase, state);
    }

    render() {
        return (
            <div className="container-fluid">
                <div className="row">
                    <div className="col-sm-6">
                        <div>
                            <p>Player: {this.props.ctx.currentPlayer} | phase: {this.props.ctx.phase} | treasury: {this.props.G.republic.treasury} |
                                unrest: {this.props.G.republic.unrest}</p>
                        </div>

                        {this.props.ctx.phase === 'mortality'
                        && <MortalityBoard {...this.props}></MortalityBoard>
                        }


                        {this.props.ctx.phase === 'revenue' && parseInt(this.props.ctx.currentPlayer, 10) === 0
                        && <RevenueBoard {...this.props}></RevenueBoard>
                        }
                        {this.props.ctx.phase === 'revenue' && parseInt(this.props.ctx.currentPlayer, 10) !== 0
                        && <RevenueBot {...this.props}></RevenueBot>
                        }


                        {this.props.ctx.phase === 'forum' && parseInt(this.props.ctx.currentPlayer, 10) === 0
                        && <ForumBoard {...this.props}></ForumBoard>}

                        {this.props.ctx.phase === 'forum' && parseInt(this.props.ctx.currentPlayer, 10) !== 0
                        && <ForumBot {...this.props}></ForumBot>}


                        {this.props.ctx.phase === 'population'
                        && <PopulationBoard {...this.props}></PopulationBoard>}

                    </div>
                    <div className="col-sm-4">
                        <button onClick={() => this.goToGameState('forum', forumState)}>GO TO FORUM</button>
                    </div>

                    <div className="col-sm-12">
                        <PlayerBoard {...this.props}></PlayerBoard>
                    </div>

                    <div className="col-sm-12">
                        <Neutrals {...this.props}></Neutrals>
                    </div>
                </div>
            </div>
        )
    }

}

const App = Client({
    game: Ror,
    board: Board,
    numPlayers: 5,
    playerView: PlayerView.STRIP_SECRETS,
    playerID: '0',
    debug: false,
    enhancer: window.__REDUX_DEVTOOLS_EXTENSION__ && window.__REDUX_DEVTOOLS_EXTENSION__()
});

export default App;
