const { randomInt } = require('node:crypto');

const personajes = [
  {
    "nombre": "Naruto Uzumaki",
    "poder": "Rasengan y Modo Sabio",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b17-phjcWCkRuIhu.png"
  },
  {
    "nombre": "Sasuke Uchiha",
    "poder": "Chidori y Amaterasu",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b13-SISLEw1oAD7a.png"
  },
  {
    "nombre": "Sakura Haruno",
    "poder": "Fuerza potenciada por chakra y ninjutsu médico",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b145-IorfpI8arxeX.png"
  },
  {
    "nombre": "Kakashi Hatake",
    "poder": "Kamui",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b85-mkVBh2yjxjmx.png"
  },
  {
    "nombre": "Itachi Uchiha",
    "poder": "Tsukuyomi y Amaterasu",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b14-9Kb1E5oel1ke.png"
  },
  {
    "nombre": "Gaara",
    "poder": "Manipulación de arena",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b1662-4E5J0LX9jZKZ.png"
  },
  {
    "nombre": "Hinata Hyuga",
    "poder": "Byakugan y Puño Suave",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b1555-Q41GLTV3FvYF.png"
  },
  {
    "nombre": "Shikamaru Nara",
    "poder": "Técnica de Posesión de Sombras",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2007-QaesJlIZDifj.jpg"
  },
  {
    "nombre": "Rock Lee",
    "poder": "Ocho Puertas Internas",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b306-oUTOO45xInXt.png"
  },
  {
    "nombre": "Minato Namikaze",
    "poder": "Técnica del Dios del Trueno Volador",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2535-Xq9WKNPJQEt3.png"
  },
  {
    "nombre": "Monkey D. Luffy",
    "poder": "Gear 5",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b40-MNypXsxSRb1R.png"
  },
  {
    "nombre": "Roronoa Zoro",
    "poder": "Estilo de Tres Espadas",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b62-S7oAeA9WInjV.png"
  },
  {
    "nombre": "Nami",
    "poder": "Clima-Tact y Zeus",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b723-vp5hPptgnNEC.png"
  },
  {
    "nombre": "Sanji",
    "poder": "Ifrit Jambe",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b305-6lisPmHtCnLT.png"
  },
  {
    "nombre": "Nico Robin",
    "poder": "Hana Hana no Mi",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b61-ywXUyyocEEqt.png"
  },
  {
    "nombre": "Trafalgar Law",
    "poder": "Ope Ope no Mi: ROOM",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b13767-U604OJN9dxCn.jpg"
  },
  {
    "nombre": "Portgas D. Ace",
    "poder": "Mera Mera no Mi",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2072-Lc6jEdsueJUK.jpg"
  },
  {
    "nombre": "Sabo",
    "poder": "Mera Mera no Mi y Ryusoken",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b32893-3weZS61cdwLD.png"
  },
  {
    "nombre": "Shanks",
    "poder": "Haki del Conquistador",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b727-wUJx7M1z5xON.png"
  },
  {
    "nombre": "Donquixote Doflamingo",
    "poder": "Ito Ito no Mi: control de hilos",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2754-B4gGSlNYgsyh.jpg"
  },
  {
    "nombre": "Goku",
    "poder": "Kamehameha",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/246-wsRRr6z1kii8.png"
  },
  {
    "nombre": "Vegeta",
    "poder": "Final Flash",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b913-NIFkKazWM8VO.png"
  },
  {
    "nombre": "Gohan",
    "poder": "Forma Bestia",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2093-kdFZhqcNSsqW.png"
  },
  {
    "nombre": "Piccolo",
    "poder": "Makankosappo",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b914-KuS8AWjqBrqa.jpg"
  },
  {
    "nombre": "Frieza",
    "poder": "Rayo Mortal",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b3694-bDfOdSSdFfPv.png"
  },
  {
    "nombre": "Cell",
    "poder": "Kamehameha Solar",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/3908.jpg"
  },
  {
    "nombre": "Trunks",
    "poder": "Burning Attack",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2707-YKWmn4q87oF8.png"
  },
  {
    "nombre": "Krillin",
    "poder": "Kienzan",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2159-qtEuMYyOUkwY.jpg"
  },
  {
    "nombre": "Android 18",
    "poder": "Ráfagas de energía",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b4318-HfIy9rOIOZXM.png"
  },
  {
    "nombre": "Broly",
    "poder": "Transformación de Super Saiyan Legendario",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b4945-iE59qIP7TxPu.png"
  },
  {
    "nombre": "Tanjiro Kamado",
    "poder": "Respiración del Sol y del Agua",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b126071-BTNEc1nRIv68.png"
  },
  {
    "nombre": "Nezuko Kamado",
    "poder": "Arte Demoníaco: Sangre Explosiva",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b127518-NRlq1CQ1v1ro.png"
  },
  {
    "nombre": "Zenitsu Agatsuma",
    "poder": "Respiración del Trueno: Destello Relámpago",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b129131-FZrQ7lSlxmEr.png"
  },
  {
    "nombre": "Inosuke Hashibira",
    "poder": "Respiración de la Bestia",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/n129130-SJC0Kn1DU39E.jpg"
  },
  {
    "nombre": "Giyu Tomioka",
    "poder": "Respiración del Agua: Calma Total",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b130050-qsLThJs5VIbz.png"
  },
  {
    "nombre": "Shinobu Kocho",
    "poder": "Respiración del Insecto y venenos",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b136070-MC9LLxJsHyHE.png"
  },
  {
    "nombre": "Kyojuro Rengoku",
    "poder": "Respiración de la Llama",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b129133-VlTPowwt68rJ.png"
  },
  {
    "nombre": "Muzan Kibutsuji",
    "poder": "Arte Demoníaco de Sangre y metamorfosis",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b129132-4nIZakUZ1o8W.jpg"
  },
  {
    "nombre": "Akaza",
    "poder": "Muerte Destructiva",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b141694-0COi0GVXPuEn.png"
  },
  {
    "nombre": "Tengen Uzui",
    "poder": "Respiración del Sonido",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b136071-99Kexnnn2PiV.png"
  },
  {
    "nombre": "Yuji Itadori",
    "poder": "Destello Negro",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b127212-FVm2tD0erQ5B.png"
  },
  {
    "nombre": "Megumi Fushiguro",
    "poder": "Técnica de las Diez Sombras",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b126635-L0y3I92JSUkN.png"
  },
  {
    "nombre": "Nobara Kugisaki",
    "poder": "Técnica del Muñeco de Paja: Resonancia",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b133700-f6sOO3TcgLV6.png"
  },
  {
    "nombre": "Satoru Gojo",
    "poder": "Infinito y Vacío Inconmensurable",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b127691-9zqh1xpIubn7.png"
  },
  {
    "nombre": "Yuta Okkotsu",
    "poder": "Copiado de técnicas con Rika",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b129571-GHJk7gviHOOw.jpg"
  },
  {
    "nombre": "Maki Zenin",
    "poder": "Restricción Celestial y combate con armas",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b134167-5TCytk45YByD.png"
  },
  {
    "nombre": "Toge Inumaki",
    "poder": "Habla Maldita",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b157115-kdhRYQdVhH95.png"
  },
  {
    "nombre": "Kento Nanami",
    "poder": "Técnica de Proporción 7:3",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b133704-8wLTGjc234q2.png"
  },
  {
    "nombre": "Ryomen Sukuna",
    "poder": "Santuario Malevolente",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b133701-rCQuDpHr3UZL.png"
  },
  {
    "nombre": "Mahito",
    "poder": "Transfiguración Ociosa",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b133702-Y7JRG5vAvjIL.png"
  },
  {
    "nombre": "Eren Yeager",
    "poder": "Titán de Ataque y Titán Fundador",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b40882-dsj7IP943WFF.jpg"
  },
  {
    "nombre": "Mikasa Ackerman",
    "poder": "Fuerza Ackerman y equipo de maniobras",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b40881-F3gr1PkreDvj.png"
  },
  {
    "nombre": "Erwin Smith",
    "poder": "Liderazgo y estrategia militar",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b46496-Mu86MENd5wNB.png"
  },
  {
    "nombre": "Armin Arlert",
    "poder": "Titán Colosal",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b46494-g7xYYuBtYPnO.png"
  },
  {
    "nombre": "Reiner Braun",
    "poder": "Titán Acorazado",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b46484-P6A2GjNQn49F.png"
  },
  {
    "nombre": "Annie Leonhart",
    "poder": "Titán Hembra",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b46490-tan274Ifc1Jf.jpg"
  },
  {
    "nombre": "Bertholdt Hoover",
    "poder": "Titán Colosal",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b46488-wm6HvkdkHoZu.jpg"
  },
  {
    "nombre": "Sasha Blouse",
    "poder": "Puntería y combate con equipo de maniobras",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b45887-QPtJH0KwqthW.jpg"
  },
  {
    "nombre": "Pieck Finger",
    "poder": "Titán Carreta",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b125603-Z2rgiHUGbAmY.png"
  },
  {
    "nombre": "Falco Grice",
    "poder": "Titán Mandíbula y forma voladora",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b125660-mrmpOJLjJIkv.jpg"
  },
  {
    "nombre": "Izuku Midoriya",
    "poder": "One For All",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b89028-8w1I9o1ISHMg.png"
  },
  {
    "nombre": "Katsuki Bakugo",
    "poder": "Explosión",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b88892-bdOha3lNcaN6.png"
  },
  {
    "nombre": "Shoto Todoroki",
    "poder": "Mitad Frío, Mitad Caliente",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b89220-KNBwaVFAR8FD.png"
  },
  {
    "nombre": "All Might",
    "poder": "One For All",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b89224-K6KEuQAuYKzq.jpg"
  },
  {
    "nombre": "Ochaco Uraraka",
    "poder": "Gravedad Cero",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b89221-gSF2a4gPbG4m.png"
  },
  {
    "nombre": "Tenya Iida",
    "poder": "Motor",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b89222-TL8MQM3wJgEB.png"
  },
  {
    "nombre": "Eijiro Kirishima",
    "poder": "Endurecimiento",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b89243-R2WJlNuj3aEs.jpg"
  },
  {
    "nombre": "Shota Aizawa",
    "poder": "Borrado de dones",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b89225-XBgvUhI9naVI.png"
  },
  {
    "nombre": "Himiko Toga",
    "poder": "Transformación mediante sangre",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b125619-iQxQoGHJvjRJ.png"
  },
  {
    "nombre": "Endeavor",
    "poder": "Hellflame",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b126158-Wix9rh7unTDQ.png"
  },
  {
    "nombre": "Ichigo Kurosaki",
    "poder": "Getsuga Tensho",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b5-a7bkJgjhhigE.png"
  },
  {
    "nombre": "Rukia Kuchiki",
    "poder": "Sode no Shirayuki",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b6-25WoBeWMZXBc.png"
  },
  {
    "nombre": "Renji Abarai",
    "poder": "Zabimaru",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b906-ImRjx5HFM8X6.png"
  },
  {
    "nombre": "Byakuya Kuchiki",
    "poder": "Senbonzakura",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b907-kgnDKeMtEN5y.png"
  },
  {
    "nombre": "Toshiro Hitsugaya",
    "poder": "Hyorinmaru",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b245-buy3Cfn6IFSB.jpg"
  },
  {
    "nombre": "Kenpachi Zaraki",
    "poder": "Combate con espada y reiatsu",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b909-slhoFBon7oiH.jpg"
  },
  {
    "nombre": "Sosuke Aizen",
    "poder": "Kyoka Suigetsu",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b1086-qR9218BjZTC0.png"
  },
  {
    "nombre": "Orihime Inoue",
    "poder": "Santen Kesshun",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b7-JdR4betokDjR.jpg"
  },
  {
    "nombre": "Uryu Ishida",
    "poder": "Técnicas Quincy y Heilig Pfeil",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b564-a6LJitrjSfKC.jpg"
  },
  {
    "nombre": "Yoruichi Shihoin",
    "poder": "Shunko",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b908-JSYUkJLCw1f0.png"
  },
  {
    "nombre": "Saitama",
    "poder": "Puño Serio",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b73935-ON5d0mAcrItd.jpg"
  },
  {
    "nombre": "Genos",
    "poder": "Cañón Incinerador",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b73979-tVi9maPID881.jpg"
  },
  {
    "nombre": "Tatsumaki",
    "poder": "Psicoquinesis",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b81929-WPVp2LQoWgkc.png"
  },
  {
    "nombre": "Garou",
    "poder": "Puño del Agua Fluyente",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b89277-xBGb4B5YISXg.png"
  },
  {
    "nombre": "Speed-o'-Sound Sonic",
    "poder": "Velocidad y técnica ninja",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b74167-FE8EtGtHUM77.png"
  },
  {
    "nombre": "Bang",
    "poder": "Puño del Agua Fluyente: Rompimiento de Roca",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/n81141-1ml7Q6X2B508.png"
  },
  {
    "nombre": "Fubuki",
    "poder": "Psicoquinesis",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b81931-fmouMoprPVbV.png"
  },
  {
    "nombre": "Atomic Samurai",
    "poder": "Corte Atómico",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b154767-B8TieN81pfMI.png"
  },
  {
    "nombre": "Boros",
    "poder": "Explosión de Estrella Colapsante Rugiente",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/n89263-GPItRQ64F27D.png"
  },
  {
    "nombre": "Metal Bat",
    "poder": "Espíritu de Lucha",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b89156-kGKJyhWnCTHy.png"
  },
  {
    "nombre": "Gon Freecss",
    "poder": "Jajanken",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b30-lyFExKyDhefc.jpg"
  },
  {
    "nombre": "Killua Zoldyck",
    "poder": "Godspeed",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b27-Z5O02kQUydpT.jpg"
  },
  {
    "nombre": "Kurapika",
    "poder": "Cadenas Nen y Cadena de Carcelero",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b28-ivA7UGnfE40a.png"
  },
  {
    "nombre": "Leorio Paradinight",
    "poder": "Puño Nen a distancia",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b29-RgzoSeKmDYzl.jpg"
  },
  {
    "nombre": "Hisoka Morow",
    "poder": "Bungee Gum",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b31-FZckOuu7L1un.png"
  },
  {
    "nombre": "Chrollo Lucilfer",
    "poder": "Skill Hunter",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b58-USOmsz3nursi.jpg"
  },
  {
    "nombre": "Biscuit Krueger",
    "poder": "Transformación y control de aura",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b13898-nHq3fRmp9uPD.png"
  },
  {
    "nombre": "Meruem",
    "poder": "Aura y fuerza del Rey Hormiga",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b23277-EYmIxzL64Mji.png"
  },
  {
    "nombre": "Isaac Netero",
    "poder": "Bodhisattva Guanyin de 100 Tipos",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b14489-WgGsdlQJka65.jpg"
  },
  {
    "nombre": "Feitan Portor",
    "poder": "Pain Packer: Sol Ardiente",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/3195.jpg"
  },
  {
    "nombre": "Asta",
    "poder": "Anti-Magia",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b123285-tKijiuQErDS0.png"
  },
  {
    "nombre": "Finral Roulacase",
    "poder": "Magia espacial: puertas de transporte",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b124433-QyoZrgIUsSpd.png"
  },
  {
    "nombre": "Noelle Silva",
    "poder": "Magia de Agua",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b123283-7nJHtKha0LSm.png"
  },
  {
    "nombre": "Yami Sukehiro",
    "poder": "Magia Oscura: Corte Dimensional",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b124440-Lpdo6y8cljV6.png"
  },
  {
    "nombre": "Mimosa Vermillion",
    "poder": "Magia de Plantas y curación",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b124438-nTvKfJaMD4d5.jpg"
  },
  {
    "nombre": "Luck Voltia",
    "poder": "Magia de Relámpago",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/124449-M67Ex2GcxmYM.jpg"
  },
  {
    "nombre": "Magna Swing",
    "poder": "Magia de Fuego",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b124439-EqjbyC8GOKW0.jpg"
  },
  {
    "nombre": "Julius Novachrono",
    "poder": "Magia del Tiempo",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b124435-gXFVXWrCcieK.jpg"
  },
  {
    "nombre": "Mereoleona Vermillion",
    "poder": "Magia de Fuego y fuerza salvaje",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b124522-lJK4Hy6Aokie.png"
  },
  {
    "nombre": "Nacht Faust",
    "poder": "Unión con demonios y magia de sombras",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b187268-vkcrcTvjNSrA.png"
  },
  {
    "nombre": "Denji",
    "poder": "Transformación del Demonio Motosierra",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b130102-FO1VHNnEnLlB.png"
  },
  {
    "nombre": "Power",
    "poder": "Manipulación de sangre",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b137079-6yLEUYR3bmpr.png"
  },
  {
    "nombre": "Aki Hayakawa",
    "poder": "Contrato con el Demonio Futuro",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b137081-TSrUR3mUJL6r.png"
  },
  {
    "nombre": "Makima",
    "poder": "Poder del Demonio del Control",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b137080-UHcynYNjb5ZU.png"
  },
  {
    "nombre": "Himeno",
    "poder": "Contrato con el Demonio Fantasma",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b144596-kvL6SD2litJu.png"
  },
  {
    "nombre": "Kobeni Higashiyama",
    "poder": "Agilidad y reflejos de cazadora",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b144594-0dbO1NSYeZ12.png"
  },
  {
    "nombre": "Hirofumi Yoshida",
    "poder": "Contrato con el Demonio Pulpo",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b162080-fbX6t96GUQpo.jpg"
  },
  {
    "nombre": "Reze",
    "poder": "Transformación del Demonio Bomba",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b148740-ceAibPxLW8rR.png"
  },
  {
    "nombre": "Angel Devil",
    "poder": "Armas creadas al consumir años de vida",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b152231-xNV2YsTRzEcS.png"
  },
  {
    "nombre": "Beam",
    "poder": "Transformación del Demonio Tiburón",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b157232-5GuWeqoFN9Kq.jpg"
  },
  {
    "nombre": "Pikachu",
    "poder": "Impactrueno",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b3891-edgrZOgCJ9do.jpg"
  },
  {
    "nombre": "Charizard",
    "poder": "Lanzallamas",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b180037-u3b2oiaWdfAm.png"
  },
  {
    "nombre": "Mewtwo",
    "poder": "Psicocorte y psicoquinesis",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b5113-hDiwLUwrbz6q.png"
  },
  {
    "nombre": "Lucario",
    "poder": "Esfera Aural",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/8364.jpg"
  },
  {
    "nombre": "Greninja",
    "poder": "Shuriken de Agua",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b216225-VQ9QOMfHrATC.jpg"
  },
  {
    "nombre": "Eevee",
    "poder": "Ataque Rápido",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b135979-8fTB1j4rvc9E.jpg"
  },
  {
    "nombre": "Bulbasaur",
    "poder": "Látigo Cepa",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b177038-GJvYbR5PhCaE.png"
  },
  {
    "nombre": "Gengar",
    "poder": "Bola Sombra",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b25680-trcx01Kv1BuL.png"
  },
  {
    "nombre": "Psyduck",
    "poder": "Confusión y ataques psíquicos",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b136296-2N0Jp2pV8DeV.png"
  },
  {
    "nombre": "Snorlax",
    "poder": "Golpe Cuerpo",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b177037-VAWVNfkeSEpZ.png"
  },
  {
    "nombre": "Agumon",
    "poder": "Aliento Pepper",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b4950-7ABdx6j3jmdE.png"
  },
  {
    "nombre": "Gabumon",
    "poder": "Aliento Azul",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b9952-mI01ix3dEKMp.png"
  },
  {
    "nombre": "Taichi Yagami",
    "poder": "Digivice: digievolución de Agumon a WarGreymon",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b1907-ZWmX1dVGPfqn.png"
  },
  {
    "nombre": "Yamato Ishida",
    "poder": "Digivice: digievolución de Gabumon a MetalGarurumon",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b1909-BFIYnrdbeLhB.png"
  },
  {
    "nombre": "Patamon",
    "poder": "Burbujas de Aire",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b9950-QAOttyTh15ti.png"
  },
  {
    "nombre": "Sora Takenouchi",
    "poder": "Digivice: digievolución de Piyomon a Garudamon",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2276-edQsS9qzUbm5.png"
  },
  {
    "nombre": "Gatomon",
    "poder": "Garra Relámpago",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/9954.jpg"
  },
  {
    "nombre": "Takeru Takaishi",
    "poder": "Digivice: digievolución de Patamon a Seraphimon",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b1961-tH2XftpODD7y.png"
  },
  {
    "nombre": "Hikari Yagami",
    "poder": "Digivice: digievolución de Gatomon a Angewomon",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b1963-dOvRGlPBRIYw.png"
  },
  {
    "nombre": "Daisuke Motomiya",
    "poder": "Digivice: digievolución por Jogress a Imperialdramon",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b1960-oYyird0GsbgC.png"
  },
  {
    "nombre": "Usagi Tsukino",
    "poder": "Cristal de Plata y Tiara Lunar",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2030-GQvVYPEYkXCy.jpg"
  },
  {
    "nombre": "Ami Mizuno",
    "poder": "Burbuja de Mercurio y control del agua",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2366-IJmfKZoSYT3N.png"
  },
  {
    "nombre": "Rei Hino",
    "poder": "Fuego de Marte",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2367-KAExXjTB13mJ.png"
  },
  {
    "nombre": "Makoto Kino",
    "poder": "Trueno Supremo de Júpiter",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2825-d7HrsHjJgixD.png"
  },
  {
    "nombre": "Minako Aino",
    "poder": "Cadena del Amor de Venus",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2826-BwX3oCmxTo6A.png"
  },
  {
    "nombre": "Mamoru Chiba",
    "poder": "Rosas y defensa de Tuxedo Mask",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b4013-pnQ2obKyW7Tv.png"
  },
  {
    "nombre": "Hotaru Tomoe",
    "poder": "Guadaña del Silencio de Sailor Saturn",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2875-kces9U1sPUNm.png"
  },
  {
    "nombre": "Haruka Tenoh",
    "poder": "Espada Espacial de Sailor Uranus",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2830-m2n08NMoFPRy.jpg"
  },
  {
    "nombre": "Michiru Kaioh",
    "poder": "Submerge Profundo de Sailor Neptune",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2829-UlgVH6pJExiB.png"
  },
  {
    "nombre": "Setsuna Meioh",
    "poder": "Control del tiempo y Puerta del Espacio-Tiempo",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2828-1mJZhqN5Tzoo.png"
  },
  {
    "nombre": "Natsu Dragneel",
    "poder": "Magia Dragon Slayer de Fuego",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b5187-y1OEdRu9sPN2.png"
  },
  {
    "nombre": "Lucy Heartfilia",
    "poder": "Magia de Espíritus Celestiales",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b5186-izgXf2S86K9u.png"
  },
  {
    "nombre": "Erza Scarlet",
    "poder": "Requip: cambio de armaduras",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b5189-GR1xdok9SFsN.jpg"
  },
  {
    "nombre": "Gray Fullbuster",
    "poder": "Magia Ice-Make",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b4839-p2SBgjdTxHxk.png"
  },
  {
    "nombre": "Wendy Marvell",
    "poder": "Magia Dragon Slayer del Cielo",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b28886-unO1rEi3zdyF.jpg"
  },
  {
    "nombre": "Gajeel Redfox",
    "poder": "Magia Dragon Slayer de Hierro",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b16893-l9HhHQ8j09H5.jpg"
  },
  {
    "nombre": "Jellal Fernandes",
    "poder": "Magia del Cuerpo Celestial",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b22751-ITQZWdiz8Ym7.png"
  },
  {
    "nombre": "Mirajane Strauss",
    "poder": "Take Over: Satan Soul",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b5190-Xql1rGKUv1ql.png"
  },
  {
    "nombre": "Laxus Dreyar",
    "poder": "Magia Dragon Slayer de Rayo",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b8294-24LS3f4VMrfs.jpg"
  },
  {
    "nombre": "Zeref Dragneel",
    "poder": "Magia negra de Ankhseram",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/37720-WfpaYoeW2OkV.jpg"
  },
  {
    "nombre": "Subaru Natsuki",
    "poder": "Retorno por Muerte",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b88573-F8yMTK9GhnTA.png"
  },
  {
    "nombre": "Emilia",
    "poder": "Magia de hielo y espíritus",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b88572-IzTwXEHSobRs.jpg"
  },
  {
    "nombre": "Rem",
    "poder": "Forma oni y magia de agua",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b88575-Ayu8UPDA8NS6.png"
  },
  {
    "nombre": "Ram",
    "poder": "Magia de viento",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b88576-NWkotUiJ3mK3.png"
  },
  {
    "nombre": "Beatrice",
    "poder": "Magia Yin",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b90181-wRPm0OEaucmw.png"
  },
  {
    "nombre": "Roswaal L. Mathers",
    "poder": "Magia de los cuatro elementos",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b90182-Ho0NS06tc6NL.png"
  },
  {
    "nombre": "Echidna",
    "poder": "Magia de la Bruja de la Avaricia",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b129330-ZUtYw4n7N0uH.png"
  },
  {
    "nombre": "Reinhard van Astrea",
    "poder": "Protecciones Divinas",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b88577-nrwzPBVwqAfO.png"
  },
  {
    "nombre": "Julius Juukulius",
    "poder": "Artes espirituales con seis espíritus",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b90183-LWx59kSa5Vjl.png"
  },
  {
    "nombre": "Puck",
    "poder": "Magia de hielo",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b5060-PWn2hc2nBy9J.jpg"
  },
  {
    "nombre": "Hwang Dongsoo",
    "poder": "Fuerza superhumana y combate de cazador",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b136075-M6VRrZyHpaI5.png"
  },
  {
    "nombre": "Cha Hae-In",
    "poder": "Espada y percepción de maná",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b138789-AhE8m0LWjE7E.png"
  },
  {
    "nombre": "Igris",
    "poder": "Técnica de espada del Caballero Rojo",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b145722-qSJ71S6vpeeM.png"
  },
  {
    "nombre": "Beru",
    "poder": "Vuelo y aliento de dragón",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b159849-p0Szb7KzD2DD.png"
  },
  {
    "nombre": "Ashborn",
    "poder": "Autoridad del Monarca de las Sombras",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b198257-qi06d0qgcX1Y.png"
  },
  {
    "nombre": "Thomas Andre",
    "poder": "Refuerzo y fuerza de Monarca",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b184540-JNscGAnjHExA.png"
  },
  {
    "nombre": "Go Gunhee",
    "poder": "Poder del Gobernante",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b138792-TXFrDA1wpbmo.png"
  },
  {
    "nombre": "Choi Jong-In",
    "poder": "Magia de fuego",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b138794-dZNdO0pvZ659.png"
  },
  {
    "nombre": "Baek Yoonho",
    "poder": "Transformación de Bestia Blanca",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b136077-IIMqRmMK5Fgs.png"
  },
  {
    "nombre": "Sung Il-Hwan",
    "poder": "Poder de los Gobernantes",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b138790-i3DFMscWID9D.jpg"
  },
  {
    "nombre": "Frieren",
    "poder": "Zoltraak y magia ofensiva",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b176754-PCnpqIOkjhFk.png"
  },
  {
    "nombre": "Fern",
    "poder": "Zoltraak de lanzamiento múltiple",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b183965-uGFohBjlFoTp.png"
  },
  {
    "nombre": "Stark",
    "poder": "Combate con hacha",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b184313-CQl6GSt4RSny.jpg"
  },
  {
    "nombre": "Himmel",
    "poder": "Esgrima del Héroe",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b184311-wQFySqYXEqf1.png"
  },
  {
    "nombre": "Heiter",
    "poder": "Magia sacerdotal y curación",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b184310-tiXvrq4FINXP.jpg"
  },
  {
    "nombre": "Eisen",
    "poder": "Fuerza y resistencia de guerrero enano",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b184312-kxd5H6iOHIq4.png"
  },
  {
    "nombre": "Flamme",
    "poder": "Magia antigua de fuego",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b219733-FgXseEhMdDE9.png"
  },
  {
    "nombre": "Aura the Guillotine",
    "poder": "Balanza de la Obediencia",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b219110-LEB5T4oG0gel.png"
  },
  {
    "nombre": "Serie",
    "poder": "Dominio mágico y repertorio de hechizos",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b219734-aS4UMAb16DGd.jpg"
  },
  {
    "nombre": "Denken",
    "poder": "Magia ofensiva y barreras",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b246058-FOtuSIUBQ4WJ.png"
  },
  {
    "nombre": "Edward Elric",
    "poder": "Alquimia sin círculo de transmutación",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b11-TA5Nuk7EDUZG.jpg"
  },
  {
    "nombre": "Alphonse Elric",
    "poder": "Alquimia de combate",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b12-tCKu8yK5kFL5.jpg"
  },
  {
    "nombre": "Roy Mustang",
    "poder": "Alquimia de fuego",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b68-moBLY2WO2am3.png"
  },
  {
    "nombre": "Riza Hawkeye",
    "poder": "Tiro de precisión",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b70-k4bCgDspyOdI.png"
  },
  {
    "nombre": "Scar",
    "poder": "Alquimia de descomposición",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b66-bLbGWXrmDqfV.png"
  },
  {
    "nombre": "Winry Rockbell",
    "poder": "Ingeniería de automail",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/63-xloedtYxiJ2E.jpg"
  },
  {
    "nombre": "King Bradley",
    "poder": "Ojo Supremo y esgrima",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b5103-jnflrjKevO3z.png"
  },
  {
    "nombre": "Alex Louis Armstrong",
    "poder": "Alquimia de combate y fuerza",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b2079-RnhPS44vyqpJ.jpg"
  },
  {
    "nombre": "Greed",
    "poder": "Escudo Definitivo de carbono",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b351-XMQzTuMy2Xtn.jpg"
  },
  {
    "nombre": "Envy",
    "poder": "Metamorfosis",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b651-S4mzVOTMzej6.png"
  },
  {
    "nombre": "Ken Kaneki",
    "poder": "Kagune Rinkaku",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b87275-mb13EWZBdbh3.png"
  },
  {
    "nombre": "Touka Kirishima",
    "poder": "Kagune Ukaku",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b87277-oUaqrI1iBzu6.png"
  },
  {
    "nombre": "Rize Kamishiro",
    "poder": "Kagune Rinkaku",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b88413-FmAvV0hGSljG.png"
  },
  {
    "nombre": "Shuu Tsukiyama",
    "poder": "Kagune Koukaku",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b88424-mFPgcZlCuODC.png"
  },
  {
    "nombre": "Nishiki Nishio",
    "poder": "Kagune Rinkaku",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b88409-rOaEex2Ml2ah.png"
  },
  {
    "nombre": "Eto Yoshimura",
    "poder": "Kakuja y kagune Ukaku",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b90231-7ZeFK1DbrAxw.jpg"
  },
  {
    "nombre": "Koutarou Amon",
    "poder": "Combate con quinque",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b88407-YwE6D75Xskxl.png"
  },
  {
    "nombre": "Juuzou Suzuya",
    "poder": "Agilidad y combate con quinque",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b88412-sIOJUnIkyFRe.png"
  },
  {
    "nombre": "Uta",
    "poder": "Kagune y creación de máscaras",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b88414-r2Xd7jJeMrvR.jpg"
  },
  {
    "nombre": "Hinami Fueguchi",
    "poder": "Kagune Ukaku y Rinkaku",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b88293-4J36uyflNWvb.png"
  },
  {
    "nombre": "Jonathan Joestar",
    "poder": "Hamon",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b8087-GTrObHQvujB5.png"
  },
  {
    "nombre": "Joseph Joestar",
    "poder": "Hamon y estrategia improvisada",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b6356-RImEfUfHpC58.png"
  },
  {
    "nombre": "Jotaro Kujo",
    "poder": "Stand Star Platinum",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b4003-gWDSEGbeOAll.png"
  },
  {
    "nombre": "Dio Brando",
    "poder": "Stand The World",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b4004-w0OtWuvjhftG.png"
  },
  {
    "nombre": "Josuke Higashikata",
    "poder": "Stand Crazy Diamond",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b13085-CkmgXL7SSLxL.jpg"
  },
  {
    "nombre": "Giorno Giovanna",
    "poder": "Stand Gold Experience Requiem",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b10529-AloL8jjZwjsg.png"
  },
  {
    "nombre": "Bruno Bucciarati",
    "poder": "Stand Sticky Fingers",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b13045-TIpIF82cMkG9.png"
  },
  {
    "nombre": "Jolyne Cujoh",
    "poder": "Stand Stone Free",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b11222-Se9QoJHDSeYY.png"
  },
  {
    "nombre": "Yoshikage Kira",
    "poder": "Stand Killer Queen",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b12055-eCEkIVV4qoCu.png"
  },
  {
    "nombre": "Rohan Kishibe",
    "poder": "Stand Heaven's Door",
    "foto": "https://s4.anilist.co/file/anilistcdn/character/large/b12659-hgT3g7q7oHnU.png"
  }
];

// Evita repetir el personaje anterior dentro de la misma instancia caliente.
// Vercel puede escalar a varias instancias independientes.
let ultimoIndice = -1;

function elegirIndice() {
  let indice = randomInt(personajes.length);
  if (indice === ultimoIndice) {
    indice = (indice + 1 + randomInt(personajes.length - 1)) % personajes.length;
  }
  ultimoIndice = indice;
  return indice;
}

function obtenerRareza(indice) {
  // Cada bloque de 20 personajes: 12 Comun, 5 Raro, 2 Epico y 1 Legendario.
  const posicion = indice % 20;
  if (posicion < 12) return 'Comun';
  if (posicion < 17) return 'Raro';
  if (posicion < 19) return 'Epico';
  return 'Legendario';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'Metodo no permitido. Usa GET.' }));
  }

  const indice = elegirIndice();
  const personaje = personajes[indice];
  const respuesta = {
    foto: personaje.foto,
    nombre: personaje.nombre,
    rareza: obtenerRareza(indice),
    poder: personaje.poder,
  };

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.end(JSON.stringify(respuesta));
};
