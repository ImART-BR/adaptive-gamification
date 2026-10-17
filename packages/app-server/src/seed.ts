// Seed content: public decks and learning paths, so a new participant has something to study on day one.
import { one, run, tx } from './db.ts';
import type { Db } from './db.ts';

interface SeedDeck {
  key: string;
  title: string;
  description: string;
  cards: [string, string][];
}

const DECKS: SeedDeck[] = [
  {
    key: 'capitais',
    title: 'Capitais do Brasil',
    description: 'Capital de cada estado.',
    cards: [
      ['Capital do Acre', 'Rio Branco'], ['Capital do Amazonas', 'Manaus'], ['Capital da Bahia', 'Salvador'], ['Capital do Ceará', 'Fortaleza'],
      ['Capital de Goiás', 'Goiânia'], ['Capital do Maranhão', 'São Luís'], ['Capital de Mato Grosso', 'Cuiabá'], ['Capital de Minas Gerais', 'Belo Horizonte'],
      ['Capital do Pará', 'Belém'], ['Capital do Paraná', 'Curitiba'], ['Capital de Pernambuco', 'Recife'], ['Capital do Rio Grande do Sul', 'Porto Alegre'],
      ['Capital de Santa Catarina', 'Florianópolis'], ['Capital do Tocantins', 'Palmas'], ['Capital do Amapá', 'Macapá'],
    ],
  },
  {
    key: 'estatistica',
    title: 'Estatística básica',
    description: 'Conceitos para começar a analisar dados.',
    cards: [
      ['O que é a média aritmética?', 'A soma dos valores dividida pelo número de valores.'],
      ['O que é a mediana?', 'O valor central dos dados ordenados.'],
      ['O que é a moda?', 'O valor que aparece com mais frequência.'],
      ['O que mede o desvio-padrão?', 'O quanto os valores se afastam, em geral, da média.'],
      ['O que é a variância?', 'A média dos quadrados dos desvios em relação à média (o desvio-padrão ao quadrado).'],
      ['O que é uma amostra?', 'Um subconjunto da população, usado para fazer inferências sobre ela.'],
      ['O que é um valor-p?', 'A probabilidade de obter um resultado tão extremo quanto o observado, se a hipótese nula for verdadeira.'],
      ['O que é um intervalo de confiança de 95%?', 'Um intervalo construído por um método que, em repetições, contém o valor verdadeiro em 95% das vezes.'],
      ['Correlação implica causalidade?', 'Não: duas variáveis podem estar associadas sem que uma cause a outra.'],
      ['O que é viés de seleção?', 'Distorção causada por a amostra não representar a população de interesse.'],
      ['O que mede o coeficiente de correlação de Pearson?', 'A força e o sentido da relação linear entre duas variáveis, de −1 a 1.'],
      ['O que é a hipótese nula?', 'A afirmação de que não há efeito ou diferença, que o teste tenta refutar.'],
    ],
  },
  {
    key: 'python',
    title: 'Python: o básico',
    description: 'Sintaxe e conceitos iniciais.',
    cards: [
      ['Como se escreve um comentário em Python?', 'Com # no início do comentário.'],
      ['Que tipo tem o valor 3.14?', 'float'],
      ['Como criar uma lista com 1, 2 e 3?', '[1, 2, 3]'],
      ['Qual é o resultado de 7 // 2?', '3 (divisão inteira).'],
      ['Qual é o resultado de 7 % 2?', '1 (resto da divisão).'],
      ['Como repetir um bloco 5 vezes?', 'for i in range(5):'],
      ['Como definir uma função chamada soma?', 'def soma(a, b):'],
      ['O que faz len(x)?', 'Devolve o número de elementos de x.'],
      ['Como pegar o último elemento de uma lista l?', 'l[-1]'],
      ['Qual a diferença entre lista e tupla?', 'A lista é mutável; a tupla não pode ser alterada depois de criada.'],
      ['Como importar a biblioteca math?', 'import math'],
      ['O que um dicionário guarda?', 'Pares chave-valor, como {"a": 1}.'],
    ],
  },
  {
    key: 'historia',
    title: 'História do Brasil: marcos',
    description: 'Datas e acontecimentos importantes.',
    cards: [
      ['Em que ano a frota de Cabral chegou ao Brasil?', '1500'],
      ['Em que ano foi declarada a Independência do Brasil?', '1822'],
      ['Em que ano foi abolida a escravidão no Brasil?', '1888 (Lei Áurea).'],
      ['Em que ano foi proclamada a República?', '1889'],
      ['Quem foi o primeiro imperador do Brasil?', 'Dom Pedro I'],
      ['Em que ano foi inaugurada Brasília?', '1960'],
      ['Em que ano começou a ditadura militar?', '1964'],
      ['Em que ano foi promulgada a atual Constituição?', '1988'],
      ['Em que ano foi lançado o Plano Real?', '1994'],
      ['Quem era o presidente quando Brasília foi inaugurada?', 'Juscelino Kubitschek'],
    ],
  },
  {
    key: 'ingles',
    title: 'Inglês: verbos comuns',
    description: 'Verbos do dia a dia, do inglês para o português.',
    cards: [
      ['to learn', 'aprender'], ['to teach', 'ensinar'], ['to build', 'construir'], ['to borrow', 'pegar emprestado'], ['to lend', 'emprestar'],
      ['to wake up', 'acordar'], ['to remember', 'lembrar'], ['to forget', 'esquecer'], ['to choose', 'escolher'], ['to improve', 'melhorar'],
      ['to arrive', 'chegar'], ['to leave', 'sair, partir'],
    ],
  },
  {
    key: 'quimica',
    title: 'Química: elementos',
    description: 'Símbolos e nomes de elementos.',
    cards: [
      ['H', 'Hidrogênio'], ['O', 'Oxigênio'], ['C', 'Carbono'], ['N', 'Nitrogênio'], ['Na', 'Sódio'], ['K', 'Potássio'],
      ['Fe', 'Ferro'], ['Au', 'Ouro'], ['Ag', 'Prata'], ['Cu', 'Cobre'], ['Pb', 'Chumbo'], ['Hg', 'Mercúrio'],
    ],
  },
];

const PATHS = [
  { key: 'dados', title: 'Trilha de dados', description: 'Comece pela estatística ou pelo Python, na ordem que preferir.', decks: ['estatistica', 'python'] },
  { key: 'cultura', title: 'Trilha de cultura geral', description: 'Geografia, história e química: siga o caminho que quiser.', decks: ['capitais', 'historia', 'quimica'] },
  { key: 'idiomas', title: 'Trilha de idiomas', description: 'Vocabulário para o dia a dia.', decks: ['ingles'] },
];

const PROPOSALS: [string, string][] = [
  ['Cartões com imagens', 'Poder colocar uma imagem na frente ou no verso do cartão.'],
  ['Importar cartões de planilha', 'Enviar um arquivo CSV e criar o baralho de uma vez.'],
  ['Estatísticas da semana', 'Um resumo do que você estudou e do que errou mais.'],
  ['Lembrete no celular', 'Um aviso para revisar no horário que você escolher.'],
  ['Cartões de múltipla escolha', 'Além de ver a resposta, escolher entre alternativas.'],
  ['Estudar sem conexão', 'Usar o app sem internet e sincronizar depois.'],
];

/** Idempotent: each part is skipped if its content already exists. */
export function seedContent(db: Db, now: number): void {
  if (!one(db, 'SELECT 1 AS x FROM proposals LIMIT 1')) {
    for (const [title, description] of PROPOSALS) run(db, 'INSERT INTO proposals (title, description, created_by, created_at) VALUES (?, ?, NULL, ?)', title, description, now);
  }
  if (one(db, 'SELECT 1 AS x FROM paths LIMIT 1')) return;
  tx(db, () => {
    const ids = new Map<string, number>();
    for (const d of DECKS) {
      const { id } = run(db, 'INSERT INTO decks (owner_id, title, description, is_public, created_at) VALUES (NULL, ?, ?, 1, ?)', d.title, d.description, now);
      ids.set(d.key, id);
      for (const [front, back] of d.cards) run(db, 'INSERT INTO cards (deck_id, front, back, created_at) VALUES (?, ?, ?, ?)', id, front, back, now);
    }
    for (const p of PATHS) {
      const { id } = run(db, 'INSERT INTO paths (key, title, description) VALUES (?, ?, ?)', p.key, p.title, p.description);
      p.decks.forEach((k, i) => run(db, 'INSERT INTO path_decks (path_id, deck_id, position) VALUES (?, ?, ?)', id, ids.get(k) as number, i));
    }
  });
}
