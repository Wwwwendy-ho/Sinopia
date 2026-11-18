// Key-based strings for the Proportions check. Every sentence is a whole template with {placeholders}; nothing is built from
// substituted words, so word order, agreement (es, fr) and measure words (zh) stay correct.
//
//   DC.i18n.t('prop.count.n', { n: 4 })   key-based lookup (also DC.i18n.tk); numbers are formatted for the language.
//   DC.i18n.list([a, b, c])               "a, b, c" with the language's own separators.
//   DC.i18n.t('Some English text')        unchanged: the older text-matching catalogue still handles every other string.
//
// Values are [en, zh-Hans, zh-Hant, es, fr]. A missing translation falls back to English. Translations are a starting point
// for a native reviewer, like the rest of the catalogue. Left and right always mean the person's own.
(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});
  const i18n = DC.i18n;
  if (!i18n) return;
  const LANGS = ['en', 'zh-Hans', 'zh-Hant', 'es', 'fr'];
  const idx = Math.max(0, LANGS.indexOf(i18n.language));
  const NB = ' ';

  const T = {
    // ---- entry, title, pickers
    'label': ['Proportions', '比例', '比例', 'Proporciones', 'Proportions'],
    'tip': ["Check the drawing's proportions against the reference: where each feature sits and how big it is.", '对照参考图检查绘画的比例：每个特征的位置和大小。', '對照參考圖檢查繪畫的比例：每個特徵的位置和大小。', 'Comprueba las proporciones del dibujo con la referencia: dónde está cada rasgo y qué tamaño tiene.', 'Vérifie les proportions du dessin par rapport à la référence : où se trouve chaque trait et sa taille.'],
    'tip.off': ['Add a drawing and a reference first.', '请先添加绘画和参考图。', '請先新增繪畫和參考圖。', 'Primero añade un dibujo y una referencia.', 'Ajoutez d’abord un dessin et une référence.'],
    'title': ['Proportions', '比例', '比例', 'Proporciones', 'Proportions'],
    'intro': ['Your drawing, measured against the reference.', '你的绘画与参考图的对照测量。', '你的繪畫與參考圖的對照測量。', 'Tu dibujo, medido frente a la referencia.', 'Votre dessin, mesuré par rapport à la référence.'],
    'help': ['How to read this', '如何阅读', '如何閱讀', 'Cómo leer esto', 'Comment lire ceci'],
    'explain': ['Each arrow shows where a feature should move to match the reference. A numbered tag on the picture has the same number in the list. Filled red tags are the bigger differences. If a point was found in the wrong place, drag it.',
      '每个箭头表示某个特征应移动到哪里才能与参考图一致。图上的编号与列表中的编号相同。实心红色标记表示较大的差异。如果某个点找错了位置，可以拖动它。',
      '每個箭頭表示某個特徵應移動到哪裡才能與參考圖一致。圖上的編號與清單中的編號相同。實心紅色標記表示較大的差異。如果某個點找錯了位置，可以拖曳它。',
      'Cada flecha muestra adónde debería moverse un rasgo para coincidir con la referencia. La etiqueta numerada de la imagen tiene el mismo número en la lista. Las etiquetas rojas rellenas son las diferencias mayores. Si un punto está mal colocado, arrástralo.',
      'Chaque flèche montre où un trait devrait aller pour correspondre à la référence. L’étiquette numérotée sur l’image porte le même numéro dans la liste. Les étiquettes rouges pleines sont les plus grandes différences. Si un point est mal placé, faites-le glisser.'],
    'close': ['Close proportions', '关闭比例检查', '關閉比例檢查', 'Cerrar proporciones', 'Fermer les proportions'],
    'sheet': ['Make the report taller or shorter', '调整报告高度', '調整報告高度', 'Cambiar la altura del informe', 'Modifier la hauteur du rapport'],
    'pin.label': ['Pin', '定位点', '定位點', 'Anclaje', 'Point fixe'],
    'size.label': ['Size by', '缩放依据', '縮放依據', 'Tamaño según', 'Taille selon'],
    'pin.auto': ['Auto (best fit)', '自动（最佳拟合）', '自動（最佳擬合）', 'Auto (mejor ajuste)', 'Auto (meilleur ajustement)'],
    'pin.eyes': ['Between the eyes', '两眼之间', '兩眼之間', 'Entre los ojos', 'Entre les yeux'],
    'pin.nose': ['Nose', '鼻子', '鼻子', 'Nariz', 'Nez'],
    'pin.chin': ['Chin', '下巴', '下巴', 'Barbilla', 'Menton'],
    'pin.mouth': ['Mouth', '嘴巴', '嘴巴', 'Boca', 'Bouche'],
    'pin.custom': ['Custom spot', '自定义位置', '自訂位置', 'Punto personalizado', 'Point personnalisé'],
    'size.auto': ['Robust auto', '稳健自动', '穩健自動', 'Auto robusto', 'Auto robuste'],
    'size.head': ['Head height (hairline to chin)', '头部高度（发际线到下巴）', '頭部高度（髮際線到下巴）', 'Altura de la cabeza (de la línea del pelo a la barbilla)', 'Hauteur de la tête (des cheveux au menton)'],
    'size.eyeChin': ['Eye line to chin', '眼线到下巴', '眼線到下巴', 'Línea de los ojos a la barbilla', 'Ligne des yeux au menton'],
    'size.eyeSpacing': ['Eye spacing', '两眼间距', '兩眼間距', 'Separación de los ojos', 'Écart entre les yeux'],
    'size.custom': ['Custom two points', '自定义两点', '自訂兩點', 'Dos puntos personalizados', 'Deux points personnalisés'],
    'chip.pin': ['Pin: {value}', '定位点：{value}', '定位點：{value}', 'Anclaje: {value}', 'Point fixe : {value}'],
    'chip.size': ['Size: {value}', '缩放：{value}', '縮放：{value}', 'Tamaño: {value}', 'Taille : {value}'],
    'pin.tip': ['Where the two pictures are pinned together. Everything is measured from here.', '两张图在此处固定在一起。所有测量都以此为起点。', '兩張圖在此處固定在一起。所有測量都以此為起點。', 'El punto donde las dos imágenes quedan fijadas. Todo se mide desde aquí.', 'L’endroit où les deux images sont fixées l’une à l’autre. Tout est mesuré à partir d’ici.'],
    'size.tip': ['The distance made equal in both pictures. All percentages are of this distance.', '在两张图中取为相等的距离。所有百分比都是相对这个距离的。', '在兩張圖中取為相等的距離。所有百分比都是相對這個距離的。', 'La distancia que se iguala en ambas imágenes. Todos los porcentajes son de esta distancia.', 'La distance rendue égale dans les deux images. Tous les pourcentages se rapportent à cette distance.'],
    'lock.size.chin_length': ['The chin is used for sizing, so it always matches. Size by something else to check it.', '下巴用于确定大小，因此它总是吻合。换一种缩放依据才能检查它。', '下巴用於決定大小，因此它總是吻合。換一種縮放依據才能檢查它。', 'La barbilla se usa para el tamaño, así que siempre coincide. Cambia el tamaño según otra cosa para comprobarla.', 'Le menton sert à la taille, donc il correspond toujours. Choisissez une autre taille pour le vérifier.'],
    'lock.size.eye_spacing': ['The eye spacing is used for sizing, so it always matches. Size by something else to check it.', '两眼间距用于确定大小，因此它总是吻合。换一种缩放依据才能检查它。', '兩眼間距用於決定大小，因此它總是吻合。換一種縮放依據才能檢查它。', 'La separación de los ojos se usa para el tamaño, así que siempre coincide. Cambia el tamaño según otra cosa para comprobarla.', 'L’écart entre les yeux sert à la taille, donc il correspond toujours. Choisissez une autre taille pour le vérifier.'],
    'lock.pin.nose_length': ['The nose is used for the pin, so its length always matches. Pin somewhere else to check it.', '鼻子用作定位点，因此鼻子长度总是吻合。换个定位点才能检查它。', '鼻子用作定位點，因此鼻子長度總是吻合。換個定位點才能檢查它。', 'La nariz se usa como anclaje, así que su longitud siempre coincide. Ancla en otro sitio para comprobarla.', 'Le nez sert de point fixe, donc sa longueur correspond toujours. Fixez ailleurs pour la vérifier.'],
    'lock.pin.chin_length': ['The chin is used for the pin, so it always matches. Pin somewhere else to check it.', '下巴用作定位点，因此它总是吻合。换个定位点才能检查它。', '下巴用作定位點，因此它總是吻合。換個定位點才能檢查它。', 'La barbilla se usa como anclaje, así que siempre coincide. Ancla en otro sitio para comprobarla.', 'Le menton sert de point fixe, donc il correspond toujours. Fixez ailleurs pour le vérifier.'],
    'lock.pin.mouth_height': ['The mouth is used for the pin, so its height always matches. Pin somewhere else to check it.', '嘴巴用作定位点，因此嘴巴高度总是吻合。换个定位点才能检查它。', '嘴巴用作定位點，因此嘴巴高度總是吻合。換個定位點才能檢查它。', 'La boca se usa como anclaje, así que su altura siempre coincide. Ancla en otro sitio para comprobarla.', 'La bouche sert de point fixe, donc sa hauteur correspond toujours. Fixez ailleurs pour la vérifier.'],
    // ---- list
    'count.one': ['1 difference', '1 处差异', '1 處差異', '1 diferencia', '1 différence'],
    'count.n': ['{n} differences', '{n} 处差异', '{n} 處差異', '{n} diferencias', '{n} différences'],
    'count.none': ['No differences found', '没有发现差异', '沒有發現差異', 'No se encontraron diferencias', 'Aucune différence trouvée'],
    'count.tol': ['{name} tolerance', '{name}容差', '{name}容差', 'Tolerancia: {name}', 'Tolérance : {name}'],
    'possible': ['possible', '可能', '可能', 'posible', 'possible'],
    'approx': ['approx.', '近似', '近似', 'aprox.', 'approx.'],
    'more': ['Show {n} more', '再显示 {n} 项', '再顯示 {n} 項', 'Mostrar {n} más', 'Afficher {n} de plus'],
    'fewer': ['Show fewer', '收起', '收起', 'Mostrar menos', 'Afficher moins'],
    'close.enough': ['Close enough: {list}.', '已足够接近：{list}。', '已足夠接近：{list}。', 'Suficientemente cerca: {list}.', 'Correspond assez bien : {list}.'],
    'none.try': ['Try Strict to see smaller ones.', '试试“严格”，可看到更小的差异。', '試試「嚴格」，可看到更小的差異。', 'Prueba Estricta para ver las más pequeñas.', 'Essayez Strict pour voir les plus petites.'],
    'list.label': ['Differences', '差异', '差異', 'Diferencias', 'Différences'],
    'row.tip': ['Difference {n}: {sentence}', '第 {n} 项差异：{sentence}', '第 {n} 項差異：{sentence}', 'Diferencia {n}: {sentence}', 'Différence {n} : {sentence}'],
    // nouns for "Close enough" (lowercase; they sit in a list)
    'noun.eye_spacing': ['eye spacing', '两眼间距', '兩眼間距', 'separación de los ojos', 'écart des yeux'],
    'noun.eye_level': ['eye level', '眼睛高度', '眼睛高度', 'altura de los ojos', 'hauteur des yeux'],
    'noun.brows': ['brows', '眉毛', '眉毛', 'cejas', 'sourcils'],
    'noun.nose_length': ['nose length', '鼻子长度', '鼻子長度', 'longitud de la nariz', 'longueur du nez'],
    'noun.nose_width': ['nose width', '鼻子宽度', '鼻子寬度', 'anchura de la nariz', 'largeur du nez'],
    'noun.mouth_height': ['mouth height', '嘴巴位置', '嘴巴位置', 'altura de la boca', 'hauteur de la bouche'],
    'noun.mouth_width': ['mouth width', '嘴巴宽度', '嘴巴寬度', 'anchura de la boca', 'largeur de la bouche'],
    'noun.chin': ['chin', '下巴', '下巴', 'barbilla', 'menton'],
    'noun.jaw': ['jaw width', '下颌宽度', '下頜寬度', 'anchura de la mandíbula', 'largeur de la mâchoire'],
    'noun.head_tilt': ['head tilt', '头部倾斜', '頭部傾斜', 'inclinación de la cabeza', 'inclinaison de la tête'],
    // ---- show, tolerance, edit
    'show': ['Show', '显示', '顯示', 'Mostrar', 'Afficher'],
    'arrows': ['Arrows', '箭头', '箭頭', 'Flechas', 'Flèches'],
    'points': ['Points', '点', '點', 'Puntos', 'Points'],
    'grid': ['Grid', '网格', '網格', 'Cuadrícula', 'Grille'],
    'arrows.tip': ['Show where each feature should move to match the reference.', '显示每个特征应移动到哪里才能与参考图一致。', '顯示每個特徵應移動到哪裡才能與參考圖一致。', 'Muestra adónde debe moverse cada rasgo para coincidir con la referencia.', 'Montre où chaque trait doit aller pour correspondre à la référence.'],
    'points.tip': ['Show every feature point. When off, only the points of the differences show.', '显示所有特征点。关闭后，只显示与差异有关的点。', '顯示所有特徵點。關閉後，只顯示與差異有關的點。', 'Muestra todos los puntos de los rasgos. Si está apagado, solo se ven los puntos de las diferencias.', 'Montre tous les points des traits. Désactivé, seuls les points des différences s’affichent.'],
    'grid.tip': ["Show the reference's squares as your drawing bends them: warm where it is stretched, blue where it is squashed.", '显示参考图的方格在你的绘画中被扭曲的样子：暖色表示被拉伸，蓝色表示被压缩。', '顯示參考圖的方格在你的繪畫中被扭曲的樣子：暖色表示被拉伸，藍色表示被壓縮。', 'Muestra los cuadrados de la referencia como los deforma tu dibujo: cálido donde se estira, azul donde se comprime.', 'Montre les carrés de la référence tels que votre dessin les déforme : chaud là où c’est étiré, bleu là où c’est écrasé.'],
    'stretched': ['Stretched', '拉伸', '拉伸', 'Estirado', 'Étiré'],
    'squashed': ['Squashed', '压缩', '壓縮', 'Comprimido', 'Écrasé'],
    'grid.cap.draw': ['Reference squares, as your drawing bends them', '参考图的方格，按你的绘画扭曲后的样子', '參考圖的方格，按你的繪畫扭曲後的樣子', 'Cuadrados de la referencia, como los deforma tu dibujo', 'Carrés de la référence, tels que votre dessin les déforme'],
    'grid.cap.ref': ['Reference squares', '参考图的方格', '參考圖的方格', 'Cuadrados de la referencia', 'Carrés de la référence'],
    'tol.label': ['Tolerance', '容差', '容差', 'Tolerancia', 'Tolérance'],
    'tol.strict': ['Strict', '严格', '嚴格', 'Estricta', 'Strict'],
    'tol.usual': ['Usual', '常规', '常規', 'Normal', 'Usuelle'],
    'tol.relaxed': ['Relaxed', '宽松', '寬鬆', 'Flexible', 'Souple'],
    'tol.tip': ['Differences smaller than this are treated as close enough. Each feature has its own limit; Strict is pickier, Relaxed more forgiving.', '小于此限度的差异视为足够接近。每个特征有各自的限度；“严格”更挑剔，“宽松”更宽容。', '小於此限度的差異視為足夠接近。每個特徵有各自的限度；「嚴格」更挑剔，「寬鬆」更寬容。', 'Las diferencias menores que esto se consideran suficientemente cercanas. Cada rasgo tiene su propio límite; Estricta es más exigente y Flexible más indulgente.', 'Les différences plus petites sont considérées comme assez proches. Chaque trait a sa propre limite ; Strict est plus exigeant, Souple plus indulgent.'],
    'edit': ['Edit points', '编辑点', '編輯點', 'Editar puntos', 'Modifier les points'],
    'edit.done': ['Done', '完成', '完成', 'Hecho', 'Terminé'],
    'edit.tip': ['Drag points to correct them, without panning by accident.', '拖动点来修正，不会误平移画面。', '拖曳點來修正，不會誤平移畫面。', 'Arrastra los puntos para corregirlos, sin desplazar la vista por accidente.', 'Faites glisser les points pour les corriger, sans déplacer la vue par erreur.'],
    'edit.strip': ['Drag any point to correct it.', '拖动任意点即可修正。', '拖曳任意點即可修正。', 'Arrastra cualquier punto para corregirlo.', 'Faites glisser un point pour le corriger.'],
    'reset': ['Reset points', '重置点', '重設點', 'Restablecer puntos', 'Réinitialiser les points'],
    'reset.tip': ['Find the features again and drop your corrections.', '重新查找特征，并放弃你的修正。', '重新尋找特徵，並放棄你的修正。', 'Vuelve a buscar los rasgos y descarta tus correcciones.', 'Retrouve les traits et abandonne vos corrections.'],
    'tilt': ['Match head tilt', '匹配头部倾斜', '匹配頭部傾斜', 'Igualar la inclinación de la cabeza', 'Aligner l’inclinaison de la tête'],
    'tilt.tip': ['Turn the drawing to the reference’s tilt, for a photo taken at an angle. Off: the tilt is reported as a difference.', '把绘画转到与参考图相同的倾斜角度，适用于斜着拍的照片。关闭时，倾斜会作为一项差异报告。', '把繪畫轉到與參考圖相同的傾斜角度，適用於斜著拍的照片。關閉時，傾斜會作為一項差異回報。', 'Gira el dibujo a la inclinación de la referencia, para una foto tomada en ángulo. Apagado: la inclinación se indica como diferencia.', 'Tourne le dessin à l’inclinaison de la référence, pour une photo prise en biais. Désactivé : l’inclinaison est signalée comme une différence.'],
    'pose.same': ['Both heads face the same way, so every measurement counts.', '两个头部朝向相同，所以每项测量都有效。', '兩個頭部朝向相同，所以每項測量都有效。', 'Las dos cabezas miran en la misma dirección, así que todas las medidas valen.', 'Les deux têtes regardent dans la même direction : toutes les mesures comptent.'],
    'pose.differs': ['The heads are turned differently, so widths are approximate.', '两个头部的转向不同，所以宽度只是近似值。', '兩個頭部的轉向不同，所以寬度只是近似值。', 'Las cabezas están giradas de forma distinta, así que las anchuras son aproximadas.', 'Les têtes sont tournées différemment : les largeurs sont approximatives.'],
    'footnote': ['Left and right are the person’s own.', '左和右均指人物自己的左右。', '左和右均指人物自己的左右。', 'Izquierda y derecha son las de la propia persona.', 'La gauche et la droite sont celles de la personne.'],
    'largest': ['Using the largest face in each picture.', '每张图中使用最大的人脸。', '每張圖中使用最大的人臉。', 'Se usa el rostro más grande de cada imagen.', 'Le plus grand visage de chaque image est utilisé.'],
    // ---- states
    'finding': ['Finding the features…', '正在查找特征…', '正在尋找特徵…', 'Buscando los rasgos…', 'Recherche des traits…'],
    'downloading': ['Getting the face finder ready. The first time it downloads about 13.5 MB; after that it is kept on this device.', '正在准备人脸查找工具。第一次需要下载约 13.5 MB，之后会保存在本设备上。', '正在準備人臉尋找工具。第一次需要下載約 13.5 MB，之後會儲存在本裝置上。', 'Preparando el buscador de rostros. La primera vez descarga unos 13,5 MB; después se guarda en este dispositivo.', 'Préparation du détecteur de visages. La première fois, il télécharge environ 13,5 Mo ; ensuite il reste sur cet appareil.'],
    'fallback': ['Using the basic detector: only larger differences are found.', '正在使用基础检测器：只能发现较大的差异。', '正在使用基礎偵測器：只能發現較大的差異。', 'Se usa el detector básico: solo se encuentran las diferencias mayores.', 'Détecteur de base utilisé : seules les plus grandes différences sont trouvées.'],
    'noface.draw': ['No face found in the drawing.', '在绘画中没有找到人脸。', '在繪畫中沒有找到人臉。', 'No se encontró ningún rostro en el dibujo.', 'Aucun visage trouvé dans le dessin.'],
    'noface.ref': ['No face found in the reference.', '在参考图中没有找到人脸。', '在參考圖中沒有找到人臉。', 'No se encontró ningún rostro en la referencia.', 'Aucun visage trouvé dans la référence.'],
    'noface.both': ['No faces found.', '没有找到人脸。', '沒有找到人臉。', 'No se encontraron rostros.', 'Aucun visage trouvé.'],
    'noface.hint': ['Light pencil lines are hard to read. You can place the points yourself.', '很浅的铅笔线条不容易识别。你可以自己放置这些点。', '很淺的鉛筆線條不容易辨識。你可以自己放置這些點。', 'Las líneas de lápiz suaves son difíciles de leer. Puedes colocar los puntos tú mismo.', 'Les traits de crayon légers sont difficiles à lire. Vous pouvez placer les points vous-même.'],
    'noface.hint.both': ['This works best with faces. You can place the points yourself, or compare outlines.', '这项功能最适合人脸。你可以自己放置这些点，或者比较轮廓。', '這項功能最適合人臉。你可以自己放置這些點，或者比較輪廓。', 'Esto funciona mejor con rostros. Puedes colocar los puntos tú mismo o comparar contornos.', 'Cela fonctionne mieux avec des visages. Vous pouvez placer les points vous-même ou comparer les contours.'],
    'place': ['Place points myself', '自己放置点', '自己放置點', 'Colocar los puntos yo mismo', 'Placer les points moi-même'],
    'outlines': ['Compare outlines', '比较轮廓', '比較輪廓', 'Comparar contornos', 'Comparer les contours'],
    'failed': ['Feature finding is not available right now. You can place the points yourself.', '目前无法查找特征。你可以自己放置这些点。', '目前無法尋找特徵。你可以自己放置這些點。', 'La búsqueda de rasgos no está disponible ahora. Puedes colocar los puntos tú mismo.', 'La recherche des traits n’est pas disponible pour le moment. Vous pouvez placer les points vous-même.'],
    'manual.used': ['You placed the points on {which}.', '你在{which}上放置了这些点。', '你在{which}上放置了這些點。', 'Has colocado los puntos en {which}.', 'Vous avez placé les points sur {which}.'],
    'which.draw': ['the drawing', '绘画', '繪畫', 'el dibujo', 'le dessin'],
    'which.ref': ['the reference', '参考图', '參考圖', 'la referencia', 'la référence'],
    'coach.title': ['Place the points yourself', '自己放置这些点', '自己放置這些點', 'Coloca los puntos tú mismo', 'Placez les points vous-même'],
    'coach.step': ['Step {i} of {n}: tap {part} on {which}.', '第 {i} 步，共 {n} 步：在{which}上点按{part}。', '第 {i} 步，共 {n} 步：在{which}上點按{part}。', 'Paso {i} de {n}: toca {part} en {which}.', 'Étape {i} sur {n} : touchez {part} sur {which}.'],
    'coach.step.click': ['Step {i} of {n}: click {part} on {which}.', '第 {i} 步，共 {n} 步：在{which}上点击{part}。', '第 {i} 步，共 {n} 步：在{which}上按一下{part}。', 'Paso {i} de {n}: haz clic en {part} en {which}.', 'Étape {i} sur {n} : cliquez sur {part} sur {which}.'],
    'coach.part.eyeR': ['the eye on the left of the picture', '画面左侧的眼睛', '畫面左側的眼睛', 'el ojo de la izquierda de la imagen', 'l’œil à gauche de l’image'],
    'coach.part.eyeL': ['the eye on the right of the picture', '画面右侧的眼睛', '畫面右側的眼睛', 'el ojo de la derecha de la imagen', 'l’œil à droite de l’image'],
    'coach.part.noseBase': ['the tip of the nose', '鼻尖', '鼻尖', 'la punta de la nariz', 'le bout du nez'],
    'coach.part.mouthCentre': ['the centre of the mouth', '嘴巴的中心', '嘴巴的中心', 'el centro de la boca', 'le centre de la bouche'],
    'coach.part.chin': ['the bottom of the chin', '下巴的最低点', '下巴的最低點', 'el punto más bajo de la barbilla', 'le bas du menton'],
    'coach.back': ['Back', '上一步', '上一步', 'Atrás', 'Retour'],
    'coach.cancel': ['Cancel', '取消', '取消', 'Cancelar', 'Annuler'],
    'coach.done': ['Points placed. Drag any of them to correct it.', '点已放好。拖动任意点即可修正。', '點已放好。拖曳任意點即可修正。', 'Puntos colocados. Arrastra cualquiera para corregirlo.', 'Points placés. Faites glisser l’un d’eux pour le corriger.'],
    'announce.open': ['{n} differences. Biggest: {sentence}.', '{n} 处差异。最大的一项：{sentence}。', '{n} 處差異。最大的一項：{sentence}。', '{n} diferencias. La mayor: {sentence}.', '{n} différences. La plus grande : {sentence}.'],
    'announce.one': ['1 difference: {sentence}.', '1 处差异：{sentence}。', '1 處差異：{sentence}。', '1 diferencia: {sentence}.', '1 différence : {sentence}.'],
    'announce.none': ['No differences found.', '没有发现差异。', '沒有發現差異。', 'No se encontraron diferencias.', 'Aucune différence trouvée.'],
    'toast.faces': ['Faces found in both images.', '两张图中都找到了人脸。', '兩張圖中都找到了人臉。', 'Se encontraron rostros en ambas imágenes.', 'Visages trouvés dans les deux images.'],
    'toast.check': ['Check proportions', '检查比例', '檢查比例', 'Comprobar proporciones', 'Vérifier les proportions'],
    'toast.needs': ['Add a drawing and a reference first.', '请先添加绘画和参考图。', '請先新增繪畫和參考圖。', 'Primero añade un dibujo y una referencia.', 'Ajoutez d’abord un dessin et une référence.'],
    'toast.lineup': ['Line up with dots was closed.', '已关闭“用点对齐”。', '已關閉「用點對齊」。', 'Se cerró Alinear con puntos.', 'L’alignement par points a été fermé.'],
    // ---- on-canvas, bubbles
    'measure.eyeChin': ['eye line to chin', '眼线到下巴', '眼線到下巴', 'línea de los ojos a la barbilla', 'ligne des yeux au menton'],
    'measure.eyeSpacing': ['eye spacing', '两眼间距', '兩眼間距', 'separación de los ojos', 'écart des yeux'],
    'measure.head': ['head height', '头部高度', '頭部高度', 'altura de la cabeza', 'hauteur de la tête'],
    'measure.custom': ['custom measure', '自定义测量', '自訂測量', 'medida personalizada', 'mesure personnalisée'],
    'pt.name': ['{name} ({which})', '{name}（{which}）', '{name}（{which}）', '{name} ({which})', '{name} ({which})'],
    'pt.hint': ['Drag to correct this point.', '拖动可修正这个点。', '拖曳可修正這個點。', 'Arrastra para corregir este punto.', 'Faites glisser pour corriger ce point.'],
    'pt.hint.edited': ['Moved by you. Reset points puts it back.', '已被你移动。“重置点”可还原。', '已被你移動。「重設點」可還原。', 'Movido por ti. Restablecer puntos lo devuelve.', 'Déplacé par vous. « Réinitialiser les points » le remet en place.'],
    'pt.drawing': ['drawing', '绘画', '繪畫', 'dibujo', 'dessin'],
    'pt.reference': ['reference', '参考图', '參考圖', 'referencia', 'référence'],
    'pin.canvas': ['Pin. Drag it to pin the pictures at another spot.', '定位点。拖动它可在另一处固定两张图。', '定位點。拖曳它可在另一處固定兩張圖。', 'Anclaje. Arrástralo para anclar las imágenes en otro punto.', 'Point fixe. Faites-le glisser pour fixer les images ailleurs.'],
    'measure.handle': ['End of the size measure. Drag it to measure between other spots.', '缩放测量的端点。拖动它可在其他位置之间测量。', '縮放測量的端點。拖曳它可在其他位置之間測量。', 'Extremo de la medida de tamaño. Arrástralo para medir entre otros puntos.', 'Extrémité de la mesure de taille. Faites-la glisser pour mesurer entre d’autres points.'],
    'points.group': ['Points of the selected difference. Arrow keys move a point by 1 pixel, Shift by 10.', '所选差异的点。方向键每次移动 1 像素，按住 Shift 移动 10 像素。', '所選差異的點。方向鍵每次移動 1 像素，按住 Shift 移動 10 像素。', 'Puntos de la diferencia seleccionada. Las flechas mueven un punto 1 píxel, con Mayús 10.', 'Points de la différence choisie. Les flèches déplacent un point d’1 pixel, avec Maj de 10.'],
    // ---- undo notes (the Undo bar)
    'undo.open.auto': ['Placed by best fit', '已按最佳拟合放置', '已按最佳擬合放置', 'Colocado por mejor ajuste', 'Placé au meilleur ajustement'],
    'undo.pin.auto': ['Pinned by best fit', '已按最佳拟合固定', '已按最佳擬合固定', 'Anclado por mejor ajuste', 'Fixé au meilleur ajustement'],
    'undo.pin.eyes': ['Pinned between the eyes', '已固定在两眼之间', '已固定在兩眼之間', 'Anclado entre los ojos', 'Fixé entre les yeux'],
    'undo.pin.nose': ['Pinned at the nose', '已固定在鼻子', '已固定在鼻子', 'Anclado en la nariz', 'Fixé au nez'],
    'undo.pin.chin': ['Pinned at the chin', '已固定在下巴', '已固定在下巴', 'Anclado en la barbilla', 'Fixé au menton'],
    'undo.pin.mouth': ['Pinned at the mouth', '已固定在嘴巴', '已固定在嘴巴', 'Anclado en la boca', 'Fixé à la bouche'],
    'undo.pin.custom': ['Pinned at a custom spot', '已固定在自定义位置', '已固定在自訂位置', 'Anclado en un punto personalizado', 'Fixé à un point personnalisé'],
    'undo.size.auto': ['Sized by robust auto', '已按稳健自动缩放', '已按穩健自動縮放', 'Tamaño por auto robusto', 'Taille par auto robuste'],
    'undo.size.head': ['Sized by head height', '已按头部高度缩放', '已按頭部高度縮放', 'Tamaño por altura de la cabeza', 'Taille par hauteur de la tête'],
    'undo.size.eyeChin': ['Sized by eye line to chin', '已按眼线到下巴缩放', '已按眼線到下巴縮放', 'Tamaño por línea de los ojos a la barbilla', 'Taille par ligne des yeux au menton'],
    'undo.size.eyeSpacing': ['Sized by eye spacing', '已按两眼间距缩放', '已按兩眼間距縮放', 'Tamaño por separación de los ojos', 'Taille par écart des yeux'],
    'undo.size.custom': ['Sized by two custom points', '已按自定义两点缩放', '已按自訂兩點縮放', 'Tamaño por dos puntos personalizados', 'Taille par deux points personnalisés'],
    'undo.moved': ['Moved the {point}', '已移动{point}', '已移動{point}', 'Movido: {point}', 'Déplacé : {point}'],
    'undo.reset': ['Points reset', '点已重置', '點已重設', 'Puntos restablecidos', 'Points réinitialisés'],
    'undo.tilt.on': ['Matched head tilt', '已匹配头部倾斜', '已匹配頭部傾斜', 'Inclinación de la cabeza igualada', 'Inclinaison de la tête alignée'],
    'undo.tilt.off': ['Head tilt left as drawn', '头部倾斜保持原样', '頭部傾斜保持原樣', 'Inclinación de la cabeza sin tocar', 'Inclinaison de la tête laissée telle quelle'],
    'undo.manual': ['Points placed by hand', '已手动放置点', '已手動放置點', 'Puntos colocados a mano', 'Points placés à la main'],
    'undo.repin': ['Pinned again', '已重新固定', '已重新固定', 'Anclado de nuevo', 'Fixé de nouveau'],
    // ---- sentences
    'sent.eyes_too_close': ['Eyes {n}% too close together', '两眼间距窄了 {n}%', '兩眼間距窄了 {n}%', 'Ojos un {n}' + NB + '% demasiado juntos', 'Yeux trop rapprochés de {n}' + NB + '%'],
    'sent.eyes_too_far_apart': ['Eyes {n}% too far apart', '两眼间距宽了 {n}%', '兩眼間距寬了 {n}%', 'Ojos un {n}' + NB + '% demasiado separados', 'Yeux trop écartés de {n}' + NB + '%'],
    'sent.eye_too_high.left': ['Left eye {n}% too high', '左眼高了 {n}%', '左眼高了 {n}%', 'Ojo izquierdo un {n}' + NB + '% demasiado alto', 'Œil gauche trop haut de {n}' + NB + '%'],
    'sent.eye_too_low.left': ['Left eye {n}% too low', '左眼低了 {n}%', '左眼低了 {n}%', 'Ojo izquierdo un {n}' + NB + '% demasiado bajo', 'Œil gauche trop bas de {n}' + NB + '%'],
    'sent.eye_too_high.right': ['Right eye {n}% too high', '右眼高了 {n}%', '右眼高了 {n}%', 'Ojo derecho un {n}' + NB + '% demasiado alto', 'Œil droit trop haut de {n}' + NB + '%'],
    'sent.eye_too_low.right': ['Right eye {n}% too low', '右眼低了 {n}%', '右眼低了 {n}%', 'Ojo derecho un {n}' + NB + '% demasiado bajo', 'Œil droit trop bas de {n}' + NB + '%'],
    'sent.eye_line_tilted_clockwise': ['Eye line tilted {d}° more clockwise than the reference', '眼线比参考图多顺时针倾斜 {d}°', '眼線比參考圖多順時針傾斜 {d}°', 'Línea de los ojos inclinada {d}° más en sentido horario que la referencia', 'Ligne des yeux inclinée de {d}° de plus dans le sens horaire que la référence'],
    'sent.eye_line_tilted_anticlockwise': ['Eye line tilted {d}° more anticlockwise than the reference', '眼线比参考图多逆时针倾斜 {d}°', '眼線比參考圖多逆時針傾斜 {d}°', 'Línea de los ojos inclinada {d}° más en sentido antihorario que la referencia', 'Ligne des yeux inclinée de {d}° de plus dans le sens antihoraire que la référence'],
    'sent.brow_too_high.left': ['Left brow {n}% too high', '左眉高了 {n}%', '左眉高了 {n}%', 'Ceja izquierda un {n}' + NB + '% demasiado alta', 'Sourcil gauche trop haut de {n}' + NB + '%'],
    'sent.brow_too_low.left': ['Left brow {n}% too low', '左眉低了 {n}%', '左眉低了 {n}%', 'Ceja izquierda un {n}' + NB + '% demasiado baja', 'Sourcil gauche trop bas de {n}' + NB + '%'],
    'sent.brow_too_high.right': ['Right brow {n}% too high', '右眉高了 {n}%', '右眉高了 {n}%', 'Ceja derecha un {n}' + NB + '% demasiado alta', 'Sourcil droit trop haut de {n}' + NB + '%'],
    'sent.brow_too_low.right': ['Right brow {n}% too low', '右眉低了 {n}%', '右眉低了 {n}%', 'Ceja derecha un {n}' + NB + '% demasiado baja', 'Sourcil droit trop bas de {n}' + NB + '%'],
    'sent.nose_too_long': ['Nose {n}% too long', '鼻子长了 {n}%', '鼻子長了 {n}%', 'Nariz un {n}' + NB + '% demasiado larga', 'Nez trop long de {n}' + NB + '%'],
    'sent.nose_too_short': ['Nose {n}% too short', '鼻子短了 {n}%', '鼻子短了 {n}%', 'Nariz un {n}' + NB + '% demasiado corta', 'Nez trop court de {n}' + NB + '%'],
    'sent.nose_too_wide': ['Nose {n}% too wide', '鼻子宽了 {n}%', '鼻子寬了 {n}%', 'Nariz un {n}' + NB + '% demasiado ancha', 'Nez trop large de {n}' + NB + '%'],
    'sent.nose_too_narrow': ['Nose {n}% too narrow', '鼻子窄了 {n}%', '鼻子窄了 {n}%', 'Nariz un {n}' + NB + '% demasiado estrecha', 'Nez trop étroit de {n}' + NB + '%'],
    'sent.mouth_too_high': ['Mouth {n}% too high', '嘴巴高了 {n}%', '嘴巴高了 {n}%', 'Boca un {n}' + NB + '% demasiado alta', 'Bouche trop haute de {n}' + NB + '%'],
    'sent.mouth_too_low': ['Mouth {n}% too low', '嘴巴低了 {n}%', '嘴巴低了 {n}%', 'Boca un {n}' + NB + '% demasiado baja', 'Bouche trop basse de {n}' + NB + '%'],
    'sent.mouth_too_wide': ['Mouth {n}% too wide', '嘴巴宽了 {n}%', '嘴巴寬了 {n}%', 'Boca un {n}' + NB + '% demasiado ancha', 'Bouche trop large de {n}' + NB + '%'],
    'sent.mouth_too_narrow': ['Mouth {n}% too narrow', '嘴巴窄了 {n}%', '嘴巴窄了 {n}%', 'Boca un {n}' + NB + '% demasiado estrecha', 'Bouche trop étroite de {n}' + NB + '%'],
    'sent.chin_too_high': ['Chin {n}% too high', '下巴高了 {n}%', '下巴高了 {n}%', 'Barbilla un {n}' + NB + '% demasiado alta', 'Menton trop haut de {n}' + NB + '%'],
    'sent.chin_too_low': ['Chin {n}% too low', '下巴低了 {n}%', '下巴低了 {n}%', 'Barbilla un {n}' + NB + '% demasiado baja', 'Menton trop bas de {n}' + NB + '%'],
    'sent.jaw_too_wide': ['Jaw {n}% too wide', '下颌宽了 {n}%', '下頜寬了 {n}%', 'Mandíbula un {n}' + NB + '% demasiado ancha', 'Mâchoire trop large de {n}' + NB + '%'],
    'sent.jaw_too_narrow': ['Jaw {n}% too narrow', '下颌窄了 {n}%', '下頜窄了 {n}%', 'Mandíbula un {n}' + NB + '% demasiado estrecha', 'Mâchoire trop étroite de {n}' + NB + '%'],
    'sent.head_tilted_clockwise': ['Head tilted {d}° more clockwise than the reference', '头部比参考图多顺时针倾斜 {d}°', '頭部比參考圖多順時針傾斜 {d}°', 'Cabeza inclinada {d}° más en sentido horario que la referencia', 'Tête inclinée de {d}° de plus dans le sens horaire que la référence'],
    'sent.head_tilted_anticlockwise': ['Head tilted {d}° more anticlockwise than the reference', '头部比参考图多逆时针倾斜 {d}°', '頭部比參考圖多逆時針傾斜 {d}°', 'Cabeza inclinada {d}° más en sentido antihorario que la referencia', 'Tête inclinée de {d}° de plus dans le sens antihoraire que la référence'],
    'sent.mouth_with_it_low': ['The mouth sits {n}% low with it', '嘴巴随之低了 {n}%', '嘴巴隨之低了 {n}%', 'La boca queda un {n}' + NB + '% más baja con ella', 'La bouche suit : {n}' + NB + '% trop basse'],
    'sent.mouth_with_it_high': ['The mouth sits {n}% high with it', '嘴巴随之高了 {n}%', '嘴巴隨之高了 {n}%', 'La boca queda un {n}' + NB + '% más alta con ella', 'La bouche suit : {n}' + NB + '% trop haute'],
    'sent.chin_with_it_low': ['The chin sits {n}% low with it', '下巴随之低了 {n}%', '下巴隨之低了 {n}%', 'La barbilla queda un {n}' + NB + '% más baja con ella', 'Le menton suit : {n}' + NB + '% trop bas'],
    'sent.chin_with_it_high': ['The chin sits {n}% high with it', '下巴随之高了 {n}%', '下巴隨之高了 {n}%', 'La barbilla queda un {n}' + NB + '% más alta con ella', 'Le menton suit : {n}' + NB + '% trop haut'],
    'sent.both_eyes_with_it': ['Both eyes move with it', '双眼随之一起移动', '雙眼隨之一起移動', 'Los dos ojos se mueven con ella', 'Les deux yeux suivent'],
    // ---- point names (the person's own left and right)
    'pt.eyeR': ['Right eye', '右眼', '右眼', 'Ojo derecho', 'Œil droit'],
    'pt.eyeL': ['Left eye', '左眼', '左眼', 'Ojo izquierdo', 'Œil gauche'],
    'pt.eyeCornerOuterR': ['Right eye, outer corner', '右眼外眼角', '右眼外眼角', 'Ojo derecho, comisura externa', 'Œil droit, coin externe'],
    'pt.eyeCornerOuterL': ['Left eye, outer corner', '左眼外眼角', '左眼外眼角', 'Ojo izquierdo, comisura externa', 'Œil gauche, coin externe'],
    'pt.eyeCornerInnerR': ['Right eye, inner corner', '右眼内眼角', '右眼內眼角', 'Ojo derecho, comisura interna', 'Œil droit, coin interne'],
    'pt.eyeCornerInnerL': ['Left eye, inner corner', '左眼内眼角', '左眼內眼角', 'Ojo izquierdo, comisura interna', 'Œil gauche, coin interne'],
    'pt.browOuterR': ['Right brow, outer end', '右眉外端', '右眉外端', 'Ceja derecha, extremo exterior', 'Sourcil droit, extrémité externe'],
    'pt.browOuterL': ['Left brow, outer end', '左眉外端', '左眉外端', 'Ceja izquierda, extremo exterior', 'Sourcil gauche, extrémité externe'],
    'pt.browMidR': ['Right brow, middle', '右眉中部', '右眉中部', 'Ceja derecha, centro', 'Sourcil droit, milieu'],
    'pt.browMidL': ['Left brow, middle', '左眉中部', '左眉中部', 'Ceja izquierda, centro', 'Sourcil gauche, milieu'],
    'pt.browInnerR': ['Right brow, inner end', '右眉内端', '右眉內端', 'Ceja derecha, extremo interior', 'Sourcil droit, extrémité interne'],
    'pt.browInnerL': ['Left brow, inner end', '左眉内端', '左眉內端', 'Ceja izquierda, extremo interior', 'Sourcil gauche, extrémité interne'],
    'pt.noseBridge': ['Nose bridge', '鼻梁', '鼻樑', 'Puente de la nariz', 'Arête du nez'],
    'pt.noseTip': ['Nose tip', '鼻尖', '鼻尖', 'Punta de la nariz', 'Bout du nez'],
    'pt.noseBase': ['Base of the nose', '鼻底', '鼻底', 'Base de la nariz', 'Base du nez'],
    'pt.noseAlaR': ['Right nostril wing', '右鼻翼', '右鼻翼', 'Ala nasal derecha', 'Aile du nez droite'],
    'pt.noseAlaL': ['Left nostril wing', '左鼻翼', '左鼻翼', 'Ala nasal izquierda', 'Aile du nez gauche'],
    'pt.mouthR': ['Right mouth corner', '右嘴角', '右嘴角', 'Comisura derecha de la boca', 'Coin droit de la bouche'],
    'pt.mouthL': ['Left mouth corner', '左嘴角', '左嘴角', 'Comisura izquierda de la boca', 'Coin gauche de la bouche'],
    'pt.lipUpper': ['Top of the upper lip', '上唇上缘', '上唇上緣', 'Borde superior del labio superior', 'Haut de la lèvre supérieure'],
    'pt.lipLower': ['Bottom of the lower lip', '下唇下缘', '下唇下緣', 'Borde inferior del labio inferior', 'Bas de la lèvre inférieure'],
    'pt.mouthCentre': ['Mouth centre', '嘴巴中心', '嘴巴中心', 'Centro de la boca', 'Centre de la bouche'],
    'pt.chin': ['Chin', '下巴', '下巴', 'Barbilla', 'Menton'],
    'pt.jawLowR': ['Right jaw, low', '右下颌下部', '右下頜下部', 'Mandíbula derecha, parte baja', 'Mâchoire droite, bas'],
    'pt.jawLowL': ['Left jaw, low', '左下颌下部', '左下頜下部', 'Mandíbula izquierda, parte baja', 'Mâchoire gauche, bas'],
    'pt.jawHighR': ['Right jaw, upper', '右下颌上部', '右下頜上部', 'Mandíbula derecha, parte alta', 'Mâchoire droite, haut'],
    'pt.jawHighL': ['Left jaw, upper', '左下颌上部', '左下頜上部', 'Mandíbula izquierda, parte alta', 'Mâchoire gauche, haut'],
    'pt.cheekR': ['Right cheekbone', '右颧骨', '右顴骨', 'Pómulo derecho', 'Pommette droite'],
    'pt.cheekL': ['Left cheekbone', '左颧骨', '左顴骨', 'Pómulo izquierdo', 'Pommette gauche'],
    'pt.hairline': ['Hairline', '发际线', '髮際線', 'Nacimiento del pelo', 'Naissance des cheveux'],
    // ---- help dialog
    'help.li': ['<strong>Proportions</strong> (<kbd>K</kbd>): checks where each feature sits compared with the reference. It finds the face in both pictures, pins them together and lists the biggest differences in plain words, with arrows and numbered tags on the pictures. Drag any point that was found in the wrong place. <em>Pin</em> and <em>Size by</em> choose how the two are matched; <em>Tolerance</em> sets how picky the check is; <em>Grid</em> shows where the drawing stretches or squashes the reference. The face finder runs on this device and downloads once (about 13.5 MB).',
      '<strong>比例</strong>（<kbd>K</kbd>）：检查每个特征相对参考图的位置。它会在两张图中找到人脸，把它们固定在一起，并用通俗的语句列出最大的差异，同时在图上用箭头和编号标出。找错位置的点可以拖动修正。<em>定位点</em>和<em>缩放依据</em>决定两张图如何匹配；<em>容差</em>决定检查有多严格；<em>网格</em>显示绘画相对参考图在哪里被拉伸或压缩。人脸查找在本设备上运行，只需下载一次（约 13.5 MB）。',
      '<strong>比例</strong>（<kbd>K</kbd>）：檢查每個特徵相對參考圖的位置。它會在兩張圖中找到人臉，把它們固定在一起，並用通俗的語句列出最大的差異，同時在圖上用箭頭和編號標出。找錯位置的點可以拖曳修正。<em>定位點</em>和<em>縮放依據</em>決定兩張圖如何匹配；<em>容差</em>決定檢查有多嚴格；<em>網格</em>顯示繪畫相對參考圖在哪裡被拉伸或壓縮。人臉尋找在本裝置上執行，只需下載一次（約 13.5 MB）。',
      '<strong>Proporciones</strong> (<kbd>K</kbd>): comprueba dónde está cada rasgo respecto a la referencia. Encuentra el rostro en las dos imágenes, las ancla entre sí y enumera las mayores diferencias con palabras sencillas, con flechas y etiquetas numeradas sobre las imágenes. Arrastra cualquier punto que esté mal colocado. <em>Anclaje</em> y <em>Tamaño según</em> eligen cómo se emparejan; <em>Tolerancia</em> define lo exigente que es la comprobación; <em>Cuadrícula</em> muestra dónde el dibujo estira o comprime la referencia. El buscador de rostros funciona en este dispositivo y se descarga una sola vez (unos 13,5 MB).',
      '<strong>Proportions</strong> (<kbd>K</kbd>) : vérifie où se trouve chaque trait par rapport à la référence. L’outil trouve le visage dans les deux images, les fixe l’une à l’autre et liste les plus grandes différences en mots simples, avec des flèches et des étiquettes numérotées sur les images. Faites glisser tout point mal placé. <em>Point fixe</em> et <em>Taille selon</em> choisissent comment les deux sont appariées ; <em>Tolérance</em> règle l’exigence ; <em>Grille</em> montre où le dessin étire ou écrase la référence. Le détecteur de visages tourne sur cet appareil et se télécharge une seule fois (environ 13,5 Mo).'],
    'help.key': ['Proportions check (Esc closes it, Shift+G shows the distortion grid)', '比例检查（Esc 关闭，Shift+G 显示变形网格）', '比例檢查（Esc 關閉，Shift+G 顯示變形網格）', 'Comprobar proporciones (Esc la cierra, Mayús+G muestra la cuadrícula de deformación)', 'Vérifier les proportions (Échap la ferme, Maj+G affiche la grille de déformation)'],
  };

  const fmtNum = new Intl.NumberFormat(i18n.language === 'en' ? 'en' : i18n.language);
  const DIGIT_PARAMS = /^(n|d|i)$/;
  function tk(key, params) {
    const full = key.startsWith('prop.') ? key.slice(5) : key;
    const row = T[full];
    if (!row) return key;
    let s = row[idx] || row[0];
    if (params) s = s.replace(/\{(\w+)\}/g, (m, name) => (name in params ? (DIGIT_PARAMS.test(name) && typeof params[name] === 'number' ? fmtNum.format(params[name]) : String(params[name])) : m));
    return s;
  }
  const has = (key) => Object.prototype.hasOwnProperty.call(T, key.startsWith('prop.') ? key.slice(5) : key);
  let listFmt = null;
  try { listFmt = new Intl.ListFormat(i18n.language, /^zh/.test(i18n.language) ? { style: 'long', type: 'conjunction' } : { style: 'short', type: 'unit' }); } catch (_) { /* older browsers: comma join below */ }
  const list = (items) => (listFmt ? listFmt.format(items) : items.join(', '));

  const oldT = i18n.t;
  i18n.tk = tk;
  i18n.has = has;
  i18n.list = list;
  i18n.t = (text, params) => (typeof text === 'string' && text.startsWith('prop.') && has(text) ? tk(text, params) : oldT(text));

  // Help dialog: one paragraph and one key line, in every language (the older help list is replaced per language in i18n.js).
  const ul = document.querySelector('#help-dialog ul.plain');
  if (ul) { const li = document.createElement('li'); li.innerHTML = tk('help.li'); ul.appendChild(li); }
  const dts = document.querySelectorAll('#help-dialog .keys dt');
  for (const dt of dts) {
    if (dt.textContent.trim() === 'D') {
      const dd = dt.nextElementSibling, nt = document.createElement('dt'), nd = document.createElement('dd');
      nt.textContent = 'K'; nd.textContent = tk('help.key');
      (dd || dt).after(nt, nd);
      break;
    }
  }
})();
