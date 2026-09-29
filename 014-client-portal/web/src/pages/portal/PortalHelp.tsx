import { useTitle } from '../../components/ui';

/** 顧客向け「ポータルの使い方」（顧客への案内.txt と同内容の要約） */
export function PortalHelp() {
  useTitle('使い方');
  return (
    <div className="stack">
      <h1>ポータルの使い方</h1>
      <div className="card">
        <h3>1. やること を確認</h3>
        <p className="small">最初の画面「やること」に、いまお願いしていることが表示されます。上から順にご対応ください。</p>
      </div>
      <div className="card">
        <h3>2. 資料を提出する（📤 資料）</h3>
        <p className="small">
          「写真・動画を選ぶ」または「ファイルを追加」で送信し、最後に「この内容で提出する」を押してください。提出後、担当者が確認すると「確認済み」になります。再提出のお願いがあった場合は理由が表示されます。
        </p>
      </div>
      <div className="card">
        <h3>3. 制作物を確認する（👀 確認）</h3>
        <p className="small">
          画像の気になる箇所は「画像にピンを置く」を押してから画像をタップし、コメントを書いて送信します。修正が必要なら「修正を依頼」、問題なければ「この内容で承認」を押してください。承認は必ず<strong>最新版</strong>に対して行われます。
        </p>
      </div>
      <div className="card">
        <h3>4. 納品物を受け取る（📦 納品）</h3>
        <p className="small">「まとめてダウンロード（ZIP）」または1つずつダウンロードできます。iPhoneでは「ファイル」アプリに保存されます。期限がある場合はお早めにお受け取りください。</p>
      </div>
      <div className="card flat">
        <h3>ホーム画面に追加（おすすめ）</h3>
        <p className="small">
          iPhone: Safari の共有ボタン → 「ホーム画面に追加」。Android: Chrome のメニュー → 「ホーム画面に追加」（または「アプリをインストール」）。
        </p>
        <h3>ご注意</h3>
        <ul className="small" style={{ paddingLeft: 20 }}>
          <li>招待リンクは他の方に転送しないでください。</li>
          <li>共用のパソコンでは、使い終わったら右上の「ログアウト」を押してください。</li>
          <li>電波が不安定な場所では送信できないことがあります。失敗した場合は「再試行」を押してください。</li>
          <li>承認は制作上の確認記録であり、電子契約・電子署名ではありません。</li>
        </ul>
      </div>
    </div>
  );
}
